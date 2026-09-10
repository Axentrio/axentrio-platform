/**
 * BK-07 — the false-success guard, wired END TO END
 * (docs/booking-test-plan-remaining-work.md §1.1)
 *
 * The rule (`docs/booking-rules.md:225`): the product must never tell a
 * customer they are booked when they are not.
 *
 * The gap this file closes is the WIRING, not the guard's logic.
 * `state.bookingRecorded` was only ever asserted TRUE
 * (`unit/agent-service.test.ts:2251`), and every output-guard test
 * hand-supplies `validationContext`
 * (`integration/guardrails-output-gate.test.ts:96`, `:110`). So no test had
 * ever driven a run in which the write actually FAILED and the model then
 * claimed success. Here the whole chain is real: real `AgentService`, real
 * `ToolRegistry`, real `create_booking`, real availability engine, real
 * Postgres. Only the LLM is scripted.
 *
 * THE FAILURE SEAM: a real Availability Rule (Mon-Fri 09:00-17:00) and a
 * request for 03:00. Nothing is injected and nothing is stubbed to reject:
 * the row in `availability_rules` is the decider, exactly as in production.
 * This is the most faithful of the three options §1.1 lists, because the
 * other two (`PLAN_CALENDAR.busyError`, a rejected `createBooking`) both
 * force the failure from outside the write path, which proves the failure is
 * HANDLED rather than that it is RAISED (convention 4).
 *
 * THE TRAP §1.1 names: asserting on the TOOL RESULT. `create_booking` already
 * returns `success: false` and that half is pinned
 * (`unit/builtin-tools.test.ts:1495-1506`). These tests assert the REPLY the
 * customer actually reads, taken out of the `messages` table after the real
 * send path wrote it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks: the same external boundaries integration/agent-escalation-handoff.test.ts stubs ──

vi.mock('../../billing/token-budget.service', () => ({
  isTokenBudgetExhausted: vi.fn().mockResolvedValue(false),
  recordTokenUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../llm/localize', () => ({
  localizeMessage: (message: string) => Promise.resolve(message),
}));

const mockRouteOutboundMessage = vi.fn().mockResolvedValue({ success: true });
vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: (...args: unknown[]) => mockRouteOutboundMessage(...args),
  routeTypingIndicator: vi.fn().mockResolvedValue(undefined),
  sendChannelTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));

// The scripted LLM. The real agent loop consumes these, so the tool call, its
// execution against Postgres, and the terminal reply are all REAL.
const chatMock = vi.fn();
vi.mock('../../llm/provider-factory', () => ({
  getProvider: () => ({ chat: (...args: unknown[]) => chatMock(...args) }),
}));

vi.mock('../../llm/rag.service', () => ({
  searchKnowledge: async () => ({ chunks: [], totalChunks: 0 }),
  generateResponse: vi.fn(),
}));

// The calendar port, doubled by the shared harness (see its usage note: the
// dynamic import is required because a `vi.mock` factory hoists above imports).
vi.mock('../../scheduler/calendar-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/calendar-provider')>()),
  ...(await import('../helpers/booking-plan-harness')).planCalendarMockModule(),
}));

// ── Import SUT after mocks ───────────────────────────────────────────────────

import {
  forwardMessageToN8n,
  initializeAgentService,
} from '../../services/message-forwarding.service';
import { AgentService } from '../../agent/agent.service';
import { ToolRegistry } from '../../agent/tool-registry';
import { PromptBuilder } from '../../agent/prompt-builder';
import { AppDataSource } from '../../database/data-source';
import { Message } from '../../database/entities/Message';
import { decrypt } from '../../utils/encryption';
import { createTestParticipant, createTestMessage } from '../helpers/factories';
import {
  PLAN_CALENDAR,
  bookingCount,
  bookingsForService,
  createPlanBusiness,
  createPlanService,
  planDate,
  planSession,
  seedPlanCalendarCredential,
  setPlanAvailability,
} from '../helpers/booking-plan-harness';
import type { ServiceType } from '../../database/entities/ServiceType';
import type { Bot } from '../../database/entities/Bot';
import type { ChatSession } from '../../database/entities/ChatSession';
import type { Tenant } from '../../database/entities/Tenant';

const messageRepo = AppDataSource.getRepository(Message);

/** A real AgentService over the real ToolRegistry/PromptBuilder. */
function realAgent(): AgentService {
  return new AgentService(
    new ToolRegistry(),
    new PromptBuilder(),
    { record: async () => {}, isOverBudget: async () => false } as never,
    { save: async () => {} } as never,
  );
}

async function botMessages(sessionId: string): Promise<string[]> {
  const msgs = await messageRepo
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .where('m.sessionId = :sessionId', { sessionId })
    .andWhere("p.type = 'bot'")
    .orderBy('m.createdAt', 'ASC')
    .getMany();
  return msgs.map((m) => (m.contentEncrypted ? decrypt(m.content) : m.content));
}

/**
 * Every tool-result message the real loop fed back to the scripted model.
 * Read out of the message history the provider was called with, so it is the
 * real `ToolRegistry` execution result, not a value this test supplied.
 */
function toolResultTexts(): string[] {
  const texts: string[] = [];
  for (const call of chatMock.mock.calls) {
    const history = call[0];
    if (!Array.isArray(history)) continue;
    for (const entry of history) {
      if (entry && typeof entry === 'object' && 'role' in entry && entry.role === 'tool' && 'content' in entry) {
        texts.push(String(entry.content));
      }
    }
  }
  return texts;
}

const usage = { promptTokens: 10, completionTokens: 10 };
const say = (content: string) => ({ content, usage, finishReason: 'stop' as const });
const callCreateBooking = (id: string, args: Record<string, unknown>) => ({
  content: '',
  usage,
  finishReason: 'tool_calls' as const,
  toolCalls: [{ id, name: 'create_booking', arguments: args }],
});

/** The exact false confirmation this guard exists to stop. */
const FALSE_CLAIM = "All set — I've confirmed your appointment for 03:00. See you then!";

/** A bookable business: availability, a connected calendar, one auto-book Service. */
async function bookableBusiness(): Promise<{
  tenant: Tenant;
  bot: Bot;
  service: ServiceType;
  session: ChatSession;
}> {
  const { tenant, bot } = await createPlanBusiness();
  await setPlanAvailability(bot);
  await seedPlanCalendarCredential(bot);
  const service = await createPlanService(bot);
  const session = await planSession(bot, { status: 'bot' });
  return { tenant, bot, service, session };
}

beforeEach(() => {
  vi.clearAllMocks();
  chatMock.mockReset();
  mockRouteOutboundMessage.mockReset().mockResolvedValue({ success: true });
  PLAN_CALENDAR.reset();
});

afterEach(() => {
  initializeAgentService(null as unknown as AgentService);
});

// ═════════════════════════════════════════════════════════════════════════════

describe('BK-07 — a failed write must never reach the customer as a confirmation', () => {
  it('[BK-07] the write fails on a real availability rule, the model claims success, and the customer is NOT told they are booked', async () => {
    initializeAgentService(realAgent());
    const { tenant, service, session } = await bookableBusiness();
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    // 03:00 on a weekday. The seeded Availability Rule is 09:00-17:00, so the
    // real slot engine refuses the write — no mock says no on its behalf.
    const startTime = `${planDate(7, { weekdayOnly: true })}T03:00:00`;

    // The model books, is told the write failed, and lies about it anyway —
    // twice, because the guard's first move is a nudge, not a replacement.
    chatMock
      .mockResolvedValueOnce(
        callCreateBooking('tc-book-1', {
          serviceId: service.id,
          startTime,
          attendeeName: 'Visitor',
          attendeeEmail: 'achraflamranim@gmail.com',
        }),
      )
      .mockResolvedValueOnce(say(FALSE_CLAIM))
      .mockResolvedValueOnce(say(FALSE_CLAIM));

    const m1 = await createTestMessage(session.id, tenant.id, user.id, {
      content: `Book me in at 03:00 on ${planDate(7, { weekdayOnly: true })}, my name is Visitor`,
      type: 'text',
      status: 'sent',
    });
    expect(await forwardMessageToN8n(session, m1)).toBe(true);

    // 1. STATE: nothing was written. Not a confirmed row, not any row.
    expect(await bookingCount(service.id, 'confirmed')).toBe(0);
    expect(await bookingsForService(service.id)).toHaveLength(0);
    // …and no calendar mirror was created either.
    expect(PLAN_CALENDAR.creates).toHaveLength(0);

    // 2. The write was really ATTEMPTED and the real slot engine really refused
    //    it. Without this the test could pass on a run where the model never
    //    called the tool at all — the "passes for the wrong reason" shape §1.1
    //    warns about. `SLOT_UNAVAILABLE` is the machine-readable code, not AI
    //    phrasing, so it is a fair thing to pin.
    expect(toolResultTexts().some((t) => t.includes('SLOT_UNAVAILABLE'))).toBe(true);

    // 3. THE ASSERTION THAT MATTERS: what the customer READ. Not the tool
    //    result (already pinned at unit/builtin-tools.test.ts:1495-1506) — the
    //    row in `messages` the send path committed.
    const replies = await botMessages(session.id);
    expect(replies).toHaveLength(1);
    const reply = replies[0];
    // The model's own words never reached the customer…
    expect(reply).not.toBe(FALSE_CLAIM);
    // …and nothing in their place claims a confirmed/booked/reserved appointment.
    //
    // Why this cannot pass for the wrong reason: an empty or missing reply would
    // also satisfy a bare `not.toMatch`, so the length check above pins that a
    // reply exists, and the guard's own replacement text is pinned below. PROVEN
    // by breaking it: with the guard's early return at agent.service.ts:1687
    // changed to ship `content` instead of BOOKING_SAFE_FALLBACK, this test fails
    // on exactly these lines; restored, it passes.
    expect(reply.toLowerCase()).not.toMatch(/\bconfirmed your (?:booking|appointment)\b/);
    expect(reply.toLowerCase()).not.toMatch(/\bi(?:'ve| have) (?:successfully )?booked\b/);
    expect(reply.toLowerCase()).not.toMatch(/\byour booking has been (?:submitted|booked|confirmed)\b/);

    // 4. And it is the guard's replacement, not a coincidence: the safe fallback
    //    asks the customer to confirm details rather than announcing anything.
    expect(reply).toBe(
      "Sorry, let me just confirm a couple of details before I put that through — could you confirm the date and time you'd like?",
    );
  });

  it('[BK-07] control: the SAME script against a bookable time writes the row and lets the confirmation through', async () => {
    initializeAgentService(realAgent());
    const { tenant, service, session } = await bookableBusiness();
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    // Identical run, one field different: 10:00 is inside the availability rule.
    // This is the discriminator. Without it, a guard that blocked EVERY booking
    // reply would pass the test above, and the suite would be pinning silence
    // rather than honesty.
    const startTime = `${planDate(7, { weekdayOnly: true })}T10:00:00`;
    const TRUE_CLAIM = "All set — I've confirmed your appointment for 10:00. See you then!";

    chatMock
      .mockResolvedValueOnce(
        callCreateBooking('tc-book-2', {
          serviceId: service.id,
          startTime,
          attendeeName: 'Visitor',
          attendeeEmail: 'achraflamranim@gmail.com',
        }),
      )
      .mockResolvedValueOnce(say(TRUE_CLAIM));

    const m1 = await createTestMessage(session.id, tenant.id, user.id, {
      content: `Book me in at 10:00 on ${planDate(7, { weekdayOnly: true })}, my name is Visitor`,
      type: 'text',
      status: 'sent',
    });
    expect(await forwardMessageToN8n(session, m1)).toBe(true);

    // The write happened, so the claim is TRUE and the guard stands down.
    expect(await bookingCount(service.id, 'confirmed')).toBe(1);
    expect(await botMessages(session.id)).toEqual([TRUE_CLAIM]);
  });
});
