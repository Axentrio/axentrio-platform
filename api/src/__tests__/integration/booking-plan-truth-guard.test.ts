/**
 * CAL-06 (reply half) and SYS-07 — one root cause, driven END TO END.
 *
 * The rule is `docs/booking-rules.md:223` and `:225`: "`CONFIRMATION_REQUIRED` is not a
 * Booking", and announcing an act without performing it is a false confirmation. Both
 * halves of this file are the same defect — the run's own state said something happened
 * when it had not.
 *
 * * [CAL-06] `create_booking` returns `success: true` for the disconnected-calendar
 *   DOWNGRADE as well as for a confirmed write, and `agent.service.ts` read that success
 *   alone to set `state.bookingRecorded`. So on the one path where the customer is most
 *   likely to be misled, the false-confirmation guard stood itself down.
 *   `booking-plan-requests.test.ts:373-380` records exactly this and deliberately does not
 *   pin it, because pinning it would have frozen the contradicted behaviour.
 *
 * * [SYS-07] `claimsBookingDone` excludes request language on purpose — a lead or handoff
 *   request is not a booking mutation — and NOTHING then judged the sentence, so "your
 *   request has been submitted" shipped green with nothing behind it. Two seams judge it
 *   now: the in-loop request guard, armed whenever a tool could have recorded the request,
 *   and the output gate, which only acts for a tenant in enforce mode.
 *
 * WHAT EACH CASE ASSERTS is the row in `messages` the send path committed, never the tool
 * result: the tool halves are already pinned (`unit/builtin-tools.test.ts`,
 * `booking-plan-requests.test.ts:340`), and a reply is what the customer actually reads.
 * Each case carries a CONTROL running the same script over a run where the thing really
 * did happen — without one, a guard that blocked every reply would look correct.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks: the boundaries booking-plan-false-success.test.ts stubs ───────────

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

// The scripted LLM. Everything downstream of it — the tool call, its execution against
// Postgres, the guards, the send path — is real.
const chatMock = vi.fn();
vi.mock('../../llm/provider-factory', () => ({
  getProvider: () => ({ chat: (...args: unknown[]) => chatMock(...args) }),
}));

vi.mock('../../llm/rag.service', () => ({
  searchKnowledge: async () => ({ chunks: [], totalChunks: 0 }),
  generateResponse: vi.fn(),
}));

// THE HARNESS STUB IS OVERRIDDEN, and [CAL-06] cannot exist without it:
// `planCalendarMockModule()` answers `hasHealthyCalendarConnection` from `busyError`, so it
// says "healthy" whether or not a `CalendarCredential` row exists. Delegating to the real
// `loadActiveCredential` is what makes an omitted credential mean "disconnected", exactly
// as production decides it (same override, same reason, as
// `booking-plan-requests.test.ts:38-47`).
vi.mock('../../scheduler/calendar-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scheduler/calendar-provider')>();
  return {
    ...actual,
    ...(await import('../helpers/booking-plan-harness')).planCalendarMockModule(),
    hasHealthyCalendarConnection: async (botId: string) => {
      const cred = await actual.loadActiveCredential(botId);
      return !!cred && !cred.reauthRequired;
    },
  };
});

vi.mock('../../automations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../automations')>()),
  getEmailService: () => ({ send: vi.fn().mockResolvedValue({ success: true, messageId: 'qa' }) }),
  initializeAutomations: vi.fn(),
}));

// Reminder JOBS are BullMQ, not a booking guarantee: only the queue drop is silenced.
vi.mock('../../booking/booking-providers/reminders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../booking/booking-providers/reminders')>()),
  cancelReminders: vi.fn().mockResolvedValue(undefined),
  scheduleReminders: vi.fn().mockResolvedValue(['qa-reminder-job']),
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
import { Tenant } from '../../database/entities/Tenant';
import { Lead } from '../../database/entities/Lead';
import { ChatSession } from '../../database/entities/ChatSession';
import { GuardrailOutputLog } from '../../database/entities/GuardrailOutputLog';
import { claimsRequestForwarded } from '../../guardrails/output-validation';
import { decrypt } from '../../utils/encryption';
import { createTestParticipant, createTestMessage } from '../helpers/factories';
import {
  PLAN_CALENDAR,
  PLAN_CUSTOMER_EMAIL,
  bookingCount,
  bookingsForService,
  createPlanBusiness,
  createPlanService,
  planDate,
  planSession,
  requestCount,
  seedPlanCalendarCredential,
  setPlanAvailability,
} from '../helpers/booking-plan-harness';
import type { ServiceType } from '../../database/entities/ServiceType';

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

/** Every tool-result message the real loop fed back to the scripted model. */
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
const callTool = (id: string, name: string, args: Record<string, unknown>) => ({
  content: '',
  usage,
  finishReason: 'tool_calls' as const,
  toolCalls: [{ id, name, arguments: args }],
});

/** The agent's replacement when a booking claim has no Booking behind it. */
const BOOKING_SAFE_FALLBACK =
  "Sorry, let me just confirm a couple of details before I put that through — could you confirm the date and time you'd like?";
/** The agent's replacement when a request claim has nothing on record behind it. */
const REQUEST_SAFE_FALLBACK =
  'Sorry, let me just confirm a couple of details first. Could you tell me again what you need, and how the team can best reach you?';
/** The tenant fallback `createPlanBusiness` seeds, sent when the output gate blocks a reply. */
const TENANT_FALLBACK = 'Let me connect you with our team.';

const BOOKED_CLAIM = "All set — I've confirmed your appointment for 10:00. See you then!";
const FORWARDED_CLAIM = 'Your request has been forwarded to the team. They will be in touch shortly.';

/** Everything one scripted turn needs: the session, and who is speaking on it. */
interface Chat {
  session: ChatSession;
  tenantId: string;
  userId: string;
}

/** Tenant switches a case varies: feature toggles, and whether the output gate enforces. */
async function configureTenant(
  tenantId: string,
  opts: { featureToggles?: NonNullable<Tenant['featureToggles']>; enforce?: boolean },
): Promise<void> {
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const row = await tenantRepo.findOneByOrFail({ id: tenantId });
  if (opts.featureToggles) row.featureToggles = { ...(row.featureToggles ?? {}), ...opts.featureToggles };
  if (opts.enforce !== undefined) row.settings = { ...(row.settings ?? {}), guardrails: { enforce: opts.enforce } };
  await tenantRepo.save(row);
}

/** An Auto-book business. The calendar credential is the thing a caller varies. */
async function autoBookBusiness(opts: {
  calendarConnected: boolean;
  enforce?: boolean;
}): Promise<Chat & { service: ServiceType }> {
  const { tenant, bot } = await createPlanBusiness();
  if (opts.enforce !== undefined) await configureTenant(tenant.id, { enforce: opts.enforce });
  await setPlanAvailability(bot);
  if (opts.calendarConnected) await seedPlanCalendarCredential(bot);
  const service = await createPlanService(bot, { bookingMode: 'auto' });
  const session = await planSession(bot, { status: 'bot' });
  const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
  return { service, session, tenantId: tenant.id, userId: user.id };
}

/**
 * A LEAD-CAPTURE bot: bookings toggled off, so `create_booking` never reaches the run and
 * the in-loop booking guard is never armed. `capture_lead` is there, so the in-loop request
 * guard IS armed. `enforce` decides whether the output gate replaces a reply or only logs.
 */
async function leadCaptureBusiness(opts: { enforce: boolean }): Promise<Chat> {
  const { tenant, bot } = await createPlanBusiness();
  await configureTenant(tenant.id, { featureToggles: { bookings: false }, enforce: opts.enforce });
  const session = await planSession(bot, { status: 'bot' });
  const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
  return { session, tenantId: tenant.id, userId: user.id };
}

/**
 * A bot with NOTHING that could record a request: no bookings, no lead capture, no handoff.
 * No in-loop guard is armed, so a request claim here can only ever be false, and the output
 * gate (enforce on) is the only seam between the sentence and the customer.
 */
async function noRecordingToolBusiness(): Promise<Chat> {
  const { tenant, bot } = await createPlanBusiness();
  await configureTenant(tenant.id, { featureToggles: { bookings: false, leadCapture: false }, enforce: true });
  // The plan has no handoff, so `escalate_to_human` is never offered. The bot's own
  // `handoffEnabled` stays on, so a blocked reply still hands off exactly as before.
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const row = await tenantRepo.findOneByOrFail({ id: tenant.id });
  row.featureOverrides = {
    ...(row.featureOverrides ?? {}),
    handoff: { value: false, reason: 'test: no handoff on this plan', setBy: 'test', setAt: new Date().toISOString() },
  };
  await tenantRepo.save(row);
  const session = await planSession(bot, { status: 'bot' });
  const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
  return { session, tenantId: tenant.id, userId: user.id };
}

/** One customer turn, driven through the real forwarding path. */
async function customerSays(chat: Chat, content: string): Promise<boolean> {
  const message = await createTestMessage(chat.session.id, chat.tenantId, chat.userId, {
    content,
    type: 'text',
    status: 'sent',
  });
  return forwardMessageToN8n(chat.session, message);
}

async function leadCount(tenantId: string): Promise<number> {
  return AppDataSource.getRepository(Lead).countBy({ tenantId });
}

async function guardrailLogCount(sessionId: string): Promise<number> {
  return AppDataSource.getRepository(GuardrailOutputLog).countBy({ conversationId: sessionId });
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

describe('CAL-06 — a Request is not a Booking, and the reply may not say it is', () => {
  it('[CAL-06] the calendar is disconnected, the create is downgraded to a Request, and the customer is NOT told they are booked', async () => {
    initializeAgentService(realAgent());
    // No credential: an Auto-book Service on a business with no connected calendar cannot be
    // auto-confirmed, so the real write path downgrades it. Nothing here is stubbed to
    // refuse — the absent `CalendarCredential` row is the decider.
    const chat = await autoBookBusiness({ calendarConnected: false });
    const { service, session } = chat;
    const startTime = `${planDate(7, { weekdayOnly: true })}T10:00:00`;

    // The model books, is handed a result that says `requested: true`, and announces a
    // confirmation anyway — twice, because the guard's first move is a nudge.
    chatMock
      .mockResolvedValueOnce(
        callTool('tc-cal06-1', 'create_booking', {
          serviceId: service.id,
          startTime,
          attendeeName: 'Visitor',
          attendeeEmail: PLAN_CUSTOMER_EMAIL,
        }),
      )
      .mockResolvedValueOnce(say(BOOKED_CLAIM))
      .mockResolvedValueOnce(say(BOOKED_CLAIM));

    expect(await customerSays(chat, `Book me in at 10:00 on ${planDate(7, { weekdayOnly: true })}, my name is Visitor`)).toBe(true);

    // 1. STATE: a Request row, and nothing confirmed on either side.
    expect(await requestCount(service.id)).toBe(1);
    expect(await bookingCount(service.id, 'confirmed')).toBe(0);
    expect(PLAN_CALENDAR.creates).toHaveLength(0);

    // 2. The downgrade really happened INSIDE the write path, and the model really was
    //    handed a success. Without this the case could pass on a run where the tool errored
    //    instead, which is a different defect with a different guard.
    expect(toolResultTexts().some((t) => t.includes('"requested":true'))).toBe(true);

    // 3. THE ASSERTION THAT MATTERS: what the customer READ.
    const replies = await botMessages(session.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toBe(BOOKED_CLAIM);
    expect(replies[0].toLowerCase()).not.toMatch(/\bi(?:'ve| have) (?:successfully )?confirmed your (?:booking|appointment)\b/);
    // And it is the guard's replacement, not a coincidence or an empty reply.
    expect(replies[0]).toBe(BOOKING_SAFE_FALLBACK);
  });

  it('[CAL-06] control: the SAME script with a connected calendar confirms the row and lets the confirmation through', async () => {
    initializeAgentService(realAgent());
    // Identical fixture, one line different: the credential exists. This is the
    // discriminator — a guard that blocked every booking reply would pass the case above.
    const chat = await autoBookBusiness({ calendarConnected: true });
    const { service, session } = chat;
    const startTime = `${planDate(7, { weekdayOnly: true })}T10:00:00`;

    chatMock
      .mockResolvedValueOnce(
        callTool('tc-cal06-2', 'create_booking', {
          serviceId: service.id,
          startTime,
          attendeeName: 'Visitor',
          attendeeEmail: PLAN_CUSTOMER_EMAIL,
        }),
      )
      .mockResolvedValueOnce(say(BOOKED_CLAIM));

    expect(await customerSays(chat, `Book me in at 10:00 on ${planDate(7, { weekdayOnly: true })}, my name is Visitor`)).toBe(true);

    expect(await bookingCount(service.id, 'confirmed')).toBe(1);
    expect(await requestCount(service.id)).toBe(0);
    const rows = await bookingsForService(service.id);
    expect(rows).toHaveLength(1);

    const replies = await botMessages(session.id);
    expect(replies).toEqual([BOOKED_CLAIM]);
  });

  // The output gate's `claimsBookingDone` leaves these out on purpose (a Dutch confirmation
  // the bot may quote, and a bare "scheduled"), so on a downgraded Request only the in-loop
  // booked-claim family stands between them and the customer.
  it.each([
    ['a Dutch confirmation', 'Top, je afspraak is bevestigd voor dinsdag om 10:00!'],
    ['"I\'ve scheduled"', "I've scheduled your appointment for 10:00. See you then!"],
    ['"successfully booked"', 'Your appointment was successfully booked for 10:00.'],
  ])('[CAL-06] on the downgraded Request, %s is not what the customer reads', async (_label, claim) => {
    initializeAgentService(realAgent());
    const chat = await autoBookBusiness({ calendarConnected: false });
    const { service, session } = chat;
    const day = planDate(7, { weekdayOnly: true });

    chatMock
      .mockResolvedValueOnce(
        callTool('tc-cal06-3', 'create_booking', {
          serviceId: service.id,
          startTime: `${day}T10:00:00`,
          attendeeName: 'Visitor',
          attendeeEmail: PLAN_CUSTOMER_EMAIL,
        }),
      )
      .mockResolvedValueOnce(say(claim))
      .mockResolvedValueOnce(say(claim));

    expect(await customerSays(chat, `Book me in at 10:00 on ${day}, my name is Visitor`)).toBe(true);

    expect(await requestCount(service.id)).toBe(1);
    expect(await bookingCount(service.id, 'confirmed')).toBe(0);
    expect(await botMessages(session.id)).toEqual([BOOKING_SAFE_FALLBACK]);
  });

  it('[CAL-06] control: on the same downgraded Request, the honest "your booking has been submitted" ships unchanged', async () => {
    initializeAgentService(realAgent());
    // Enforce on, so the output gate would replace the reply if it judged the sentence false.
    const chat = await autoBookBusiness({ calendarConnected: false, enforce: true });
    const { service, session } = chat;
    const day = planDate(7, { weekdayOnly: true });
    const submitted = 'Your booking has been submitted for approval. The team will confirm it shortly.';

    chatMock
      .mockResolvedValueOnce(
        callTool('tc-cal06-4', 'create_booking', {
          serviceId: service.id,
          startTime: `${day}T10:00:00`,
          attendeeName: 'Visitor',
          attendeeEmail: PLAN_CUSTOMER_EMAIL,
        }),
      )
      .mockResolvedValueOnce(say(submitted))
      .mockResolvedValueOnce(say(submitted));

    expect(await customerSays(chat, `Book me in at 10:00 on ${day}, my name is Visitor`)).toBe(true);

    // The Request the sentence is about really exists…
    expect(await requestCount(service.id)).toBe(1);
    // …so neither the loop nor the output gate replaces it, and nothing is flagged.
    expect(await botMessages(session.id)).toEqual([submitted]);
    expect(await guardrailLogCount(session.id)).toBe(0);
  });
});

describe('a lead or handoff licenses a request claim, never a booking claim', () => {
  it('a captured lead does not stand the booking nudge down for "I\'ll go ahead and book"', async () => {
    initializeAgentService(realAgent());
    // A connected calendar, so the only thing missing is the create call itself.
    const chat = await autoBookBusiness({ calendarConnected: true });
    const { service, session, tenantId } = chat;
    const goAhead = "Great, I'll go ahead and book Tuesday at 10:00 for you now.";

    chatMock
      .mockResolvedValueOnce(
        callTool('tc-lead-1', 'capture_lead', {
          name: 'Visitor',
          email: PLAN_CUSTOMER_EMAIL,
          summary: 'Wants Tuesday at 10:00',
        }),
      )
      .mockResolvedValueOnce(say(goAhead))
      .mockResolvedValueOnce(say(goAhead));

    expect(await customerSays(chat, `Can I come in Tuesday at 10:00? My email is ${PLAN_CUSTOMER_EMAIL}`)).toBe(true);

    // The lead is real, and it is all that exists: no Booking, no Request.
    expect(await leadCount(tenantId)).toBe(1);
    expect(await bookingCount(service.id, 'confirmed')).toBe(0);
    expect(await requestCount(service.id)).toBe(0);
    expect(await botMessages(session.id)).toEqual([BOOKING_SAFE_FALLBACK]);
  });
});

describe('SYS-07 — a request-forwarded claim needs a recorded request', () => {
  it('[SYS-07] nothing was recorded, so the claim never reaches the customer', async () => {
    initializeAgentService(realAgent());
    const chat = await noRecordingToolBusiness();
    const { session, tenantId } = chat;

    // No tool call at all. The model simply says it has been dealt with.
    chatMock.mockResolvedValueOnce(say(FORWARDED_CLAIM));

    expect(await customerSays(chat, 'Can someone call me about a broken tap?')).toBe(true);

    // 1. STATE: nothing was written. No lead, no request, nothing to forward.
    expect(await leadCount(tenantId)).toBe(0);

    // 2. What the customer READ is the tenant fallback, not the claim.
    const replies = await botMessages(session.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toBe(FORWARDED_CLAIM);
    expect(replies[0]).toBe(TENANT_FALLBACK);

    // 3. And it was THIS guard that replaced it. The family is written only by
    //    `validateOutput`'s request check, and no in-loop guard is armed on this bot, so
    //    this pins the output-gate seam alone.
    const log = await AppDataSource.getRepository(GuardrailOutputLog).findOneByOrFail({
      conversationId: session.id,
    });
    expect(log.families).toContain('fake_request_confirmation');
    expect(log.enforced).toBe(true);
  });

  it('[SYS-07] control: the SAME sentence ships unchanged once the lead row is really written', async () => {
    initializeAgentService(realAgent());
    const chat = await leadCaptureBusiness({ enforce: true });
    const { session, tenantId } = chat;

    chatMock
      .mockResolvedValueOnce(
        callTool('tc-sys07-1', 'capture_lead', {
          name: 'Visitor',
          email: PLAN_CUSTOMER_EMAIL,
          summary: 'Broken tap, wants a call back',
        }),
      )
      .mockResolvedValueOnce(say(FORWARDED_CLAIM));

    expect(await customerSays(chat, `Can someone call me about a broken tap? My email is ${PLAN_CUSTOMER_EMAIL}`)).toBe(true);

    // The row the sentence is about really exists…
    expect(await leadCount(tenantId)).toBe(1);
    // …so the customer reads the model's own words, unchanged, and nothing was flagged.
    const replies = await botMessages(session.id);
    expect(replies).toEqual([FORWARDED_CLAIM]);
    expect(await guardrailLogCount(session.id)).toBe(0);
  });

  it('[SYS-07] a tenant on the default shadow mode is protected too: the loop nudges, then replaces the claim', async () => {
    initializeAgentService(realAgent());
    // No `enforce`: the output gate would log this claim and still send it.
    const chat = await leadCaptureBusiness({ enforce: false });
    const { session, tenantId } = chat;

    chatMock.mockResolvedValueOnce(say(FORWARDED_CLAIM)).mockResolvedValueOnce(say(FORWARDED_CLAIM));

    expect(await customerSays(chat, 'Can someone call me about a broken tap?')).toBe(true);

    expect(await leadCount(tenantId)).toBe(0);
    expect(await botMessages(session.id)).toEqual([REQUEST_SAFE_FALLBACK]);
    // The in-loop guard replaced the claim before the output gate saw it.
    expect(await guardrailLogCount(session.id)).toBe(0);
  });

  it('[SYS-07] control: on shadow mode, a model that records the lead after the nudge ships the same sentence', async () => {
    initializeAgentService(realAgent());
    const chat = await leadCaptureBusiness({ enforce: false });
    const { session, tenantId } = chat;

    chatMock
      .mockResolvedValueOnce(say(FORWARDED_CLAIM))
      .mockResolvedValueOnce(
        callTool('tc-sys07-2', 'capture_lead', {
          name: 'Visitor',
          email: PLAN_CUSTOMER_EMAIL,
          summary: 'Broken tap, wants a call back',
        }),
      )
      .mockResolvedValueOnce(say(FORWARDED_CLAIM));

    expect(await customerSays(chat, `Can someone call me about a broken tap? My email is ${PLAN_CUSTOMER_EMAIL}`)).toBe(true);

    expect(await leadCount(tenantId)).toBe(1);
    expect(await botMessages(session.id)).toEqual([FORWARDED_CLAIM]);
  });

  it('[SYS-07] an honest restatement on a LATER turn ships, and the bot stays on', async () => {
    initializeAgentService(realAgent());
    const chat = await leadCaptureBusiness({ enforce: true });
    const { session, tenantId } = chat;
    const restated = 'Yes, your details have been passed on to the team.';

    chatMock
      .mockResolvedValueOnce(
        callTool('tc-sys07-3', 'capture_lead', {
          name: 'Visitor',
          email: PLAN_CUSTOMER_EMAIL,
          summary: 'Broken tap, wants a call back',
        }),
      )
      .mockResolvedValueOnce(say(FORWARDED_CLAIM))
      // Turn 2 makes no tool call: the lead was written on turn 1.
      .mockResolvedValueOnce(say(restated));

    expect(await customerSays(chat, `Can someone call me about a broken tap? My email is ${PLAN_CUSTOMER_EMAIL}`)).toBe(true);

    // The next turn arrives on a freshly loaded session, as it does in production.
    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const nextTurn: Chat = { ...chat, session: await sessionRepo.findOneByOrFail({ id: session.id }) };
    expect(await customerSays(nextTurn, 'So someone will call me?')).toBe(true);

    expect(await leadCount(tenantId)).toBe(1);
    expect(await botMessages(session.id)).toEqual([FORWARDED_CLAIM, restated]);
    expect(await guardrailLogCount(session.id)).toBe(0);
    // No `bot_error` handoff: the conversation is still the bot's.
    expect((await sessionRepo.findOneByOrFail({ id: session.id })).status).toBe('bot');
  });

  it('[SYS-07] when the row predates the latch, the fallback asserts nothing in either direction', async () => {
    initializeAgentService(realAgent());
    const chat = await leadCaptureBusiness({ enforce: true });
    const { session, tenantId } = chat;
    const restated = 'Yes, your details have been passed on to the team.';

    chatMock
      .mockResolvedValueOnce(
        callTool('tc-sys07-4', 'capture_lead', {
          name: 'Visitor',
          email: PLAN_CUSTOMER_EMAIL,
          summary: 'Broken tap, wants a call back',
        }),
      )
      .mockResolvedValueOnce(say(FORWARDED_CLAIM))
      .mockResolvedValueOnce(say(restated))
      .mockResolvedValueOnce(say(restated));

    expect(await customerSays(chat, `Can someone call me about a broken tap? My email is ${PLAN_CUSTOMER_EMAIL}`)).toBe(true);

    // A conversation opened before `requestOnRecord` existed: the lead row is real, the latch is not.
    await AppDataSource.query(`UPDATE chat_sessions SET metadata = metadata - 'requestOnRecord' WHERE id = $1`, [session.id]);
    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const nextTurn: Chat = { ...chat, session: await sessionRepo.findOneByOrFail({ id: session.id }) };
    expect(await customerSays(nextTurn, 'So the team has it?')).toBe(true);

    expect(await leadCount(tenantId)).toBe(1);
    const replies = await botMessages(session.id);
    expect(replies).toEqual([FORWARDED_CLAIM, REQUEST_SAFE_FALLBACK]);
    // The guard cannot see the row, so its reply may neither claim it nor deny it.
    expect(claimsRequestForwarded(replies[1])).toBe(false);
    expect(replies[1].toLowerCase()).not.toMatch(/\b(?:not|never|haven't|hasn't|nothing|no one)\b/);
  });
});
