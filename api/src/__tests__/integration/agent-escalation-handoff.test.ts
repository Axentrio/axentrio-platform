/**
 * Escalation bridge — Integration Tests (plan-booking-behaviour.md, PR 2 / Fix 3)
 *
 * `escalate_to_human` used to be a SOFT escalation: the tool told the model
 * "escalated: true" and nothing else happened — no handoff row, no session
 * move, nobody notified. The bot PROMISED a human while nothing reached the
 * inbox. These tests prove the bridge end-to-end through the REAL paths:
 *
 *   1. Deterministic multi-turn drive (real AgentService + real ToolRegistry,
 *      scripted LLM provider): the model asks about a human, the customer says
 *      yes, the model calls `escalate_to_human` → exactly ONE handoff row with
 *      reason `escalation_trigger`, session moved to handoff — through the
 *      legacy message-forwarding mapping.
 *   2. Tool gating: `features.handoffEnabled: false` withholds the tool (and
 *      the ## ESCALATION / insist-ladder prompt lines with it); an ABSENT
 *      `features` bag (a normal bot) still gets the tool.
 *   3. Precedence: a successful escalation followed by a LATER provider
 *      failure (infraFailure — which otherwise does NOT hand off, per PR #106)
 *      still hands off exactly once with `escalation_trigger`.
 *   4. The coalescer mapping (`runTurn`): `handoffRequested: true` fires one
 *      `escalation_trigger` handoff, defeats the stale guard (a newer customer
 *      message must not roll back the turn that asked for a human), and wins
 *      over an infra error there too. Controls pin the pre-existing behaviour
 *      when `handoffRequested` is absent.
 *
 * Real DB; mocked external boundaries (LLM provider, sockets, outbound router,
 * localization) — the same seams message-forwarding.test.ts mocks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
import {
  createTestTenant,
  createTestAnchorBot,
  createTestSession,
  createTestParticipant,
  createTestMessage,
} from '../helpers/factories';
import { BotSettings } from '../../database/entities/Bot';
import { decrypt } from '../../utils/encryption';
import type { ChatMessage, LLMOptions } from '../../llm/llm.types';

// ── Mocks (same external boundaries as message-forwarding.test.ts) ───────────

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

// The scripted LLM. Each test enqueues responses; the real agent loop consumes
// them, so the tool call, its execution, and the terminal result are all REAL.
const chatMock = vi.fn();
vi.mock('../../llm/provider-factory', () => ({
  getProvider: () => ({ chat: (...args: unknown[]) => chatMock(...args) }),
}));

// KB pre-fetch would otherwise embed + vector-search for real. Empty = the
// model can still "call" kb_search, but nothing external is hit.
vi.mock('../../llm/rag.service', () => ({
  searchKnowledge: async () => ({ chunks: [], totalChunks: 0 }),
  generateResponse: vi.fn(),
}));

// ── Import SUT after mocks ───────────────────────────────────────────────────

import {
  forwardMessageToN8n,
  runTurn,
  getNewestUnansweredUserMessage,
  initializeAgentService,
} from '../../services/message-forwarding.service';
import { AgentService } from '../../agent/agent.service';
import { ToolRegistry } from '../../agent/tool-registry';
import { PromptBuilder } from '../../agent/prompt-builder';

const sessionRepo = AppDataSource.getRepository(ChatSession);
const messageRepo = AppDataSource.getRepository(Message);
const handoffRepo = AppDataSource.getRepository(HandoffRequest);

const AI = {
  enabled: true,
  provider: 'openai' as const,
  model: 'gpt-4o-mini',
  brandVoice: { name: 'TestBot', tone: 'friendly' as const },
  guardrails: {
    topicsToAvoid: [],
    escalationKeywords: [], // keyword path OFF — these tests drive the TOOL path
    confidenceThreshold: 0.5,
    maxResponseLength: 500,
    greetingMessage: 'Hi',
    fallbackMessage: 'Connecting you to a human.',
    offHoursMessage: 'Closed.',
  },
};

/** A real AgentService over the real ToolRegistry/PromptBuilder; only the LLM
 *  provider (mocked above), metering, and tracing are stubbed. */
function realAgent(): AgentService {
  return new AgentService(
    new ToolRegistry(),
    new PromptBuilder(),
    { record: async () => {}, isOverBudget: async () => false } as never,
    { save: async () => {} } as never,
  );
}

async function makeTenant(features?: BotSettings['features']) {
  const tenant = await createTestTenant({ settings: { ai: { apiKey: 'sk-test' } } as never });
  await createTestAnchorBot(tenant, {
    settings: { ai: AI, ...(features ? { features } : {}) } as BotSettings,
  });
  return tenant;
}

async function makeTurn(tenantId: string, sessionId: string, participantId: string, content: string) {
  return createTestMessage(sessionId, tenantId, participantId, { content, type: 'text', status: 'sent' });
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

const usage = { promptTokens: 10, completionTokens: 10 };

/** The provider-call shapes the scripted model returns. */
const say = (content: string) => ({ content, usage, finishReason: 'stop' as const });
const callEscalate = () => ({
  content: '',
  usage,
  finishReason: 'tool_calls' as const,
  toolCalls: [{ id: 'tc-esc-1', name: 'escalate_to_human', arguments: { reason: 'Customer wants a human for booking' } }],
});

beforeEach(() => {
  vi.clearAllMocks();
  chatMock.mockReset();
  mockRouteOutboundMessage.mockReset().mockResolvedValue({ success: true });
});

afterEach(() => {
  initializeAgentService(null as unknown as AgentService);
});

// ═════════════════════════════════════════════════════════════════════════════

describe('escalation bridge — real agent loop through the legacy mapping', () => {
  it('multi-turn: model asks about a human, customer says yes, tool call → exactly ONE escalation_trigger handoff + session handed off', async () => {
    initializeAgentService(realAgent());
    const tenant = await makeTenant(); // features ABSENT — the normal bot
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });

    // Turn 1 — the customer insists on booking; the scripted model follows the
    // ladder and ASKS about a human (no tool call yet).
    chatMock.mockResolvedValueOnce(
      say('I cannot schedule appointments here. Would you like me to connect you with a human?'),
    );
    const m1 = await makeTurn(tenant.id, session.id, user.id, 'I really want to book an appointment now');
    expect(await forwardMessageToN8n(session, m1)).toBe(true);

    // Asking is not escalating — nothing handed off yet.
    expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
    expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('bot');

    // Turn 2 — the customer says yes; the model calls the tool, then confirms.
    chatMock.mockResolvedValueOnce(callEscalate()).mockResolvedValueOnce(say('Connecting you with a human now.'));
    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    const m2 = await makeTurn(tenant.id, session.id, user.id, 'Yes please');
    expect(await forwardMessageToN8n(fresh, m2)).toBe(true);

    // The tool was actually OFFERED to the model (features absent ⇒ offered),
    // and the prompt carried the insist ladder to get here.
    const turn2Opts = chatMock.mock.calls[1][1] as LLMOptions;
    expect(turn2Opts.tools?.map((t) => t.name)).toContain('escalate_to_human');
    const turn2System = (chatMock.mock.calls[1][0] as ChatMessage[])[0].content as string;
    expect(turn2System).toContain('ask whether they would like you to connect them with a human');

    // Exactly ONE handoff, with the explicit-escalation reason, and the session
    // is a human's now.
    const handoffs = await handoffRepo.find({ where: { sessionId: session.id } });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].reason).toBe('escalation_trigger');
    expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('handoff');

    // The customer still got the reply BEFORE being handed off.
    expect(await botMessages(session.id)).toEqual([
      'I cannot schedule appointments here. Would you like me to connect you with a human?',
      'Connecting you with a human now.',
    ]);
  });

  it('handoffEnabled: false withholds the tool — never offered, never promised, never handed off', async () => {
    initializeAgentService(realAgent());
    const tenant = await makeTenant({ fileUploadEnabled: true, handoffEnabled: false });
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });

    chatMock.mockResolvedValueOnce(say('I cannot schedule appointments here, but I can take your details.'));
    const m1 = await makeTurn(tenant.id, session.id, user.id, 'I want to book an appointment');
    expect(await forwardMessageToN8n(session, m1)).toBe(true);

    // Tool absent from the model's toolbox…
    const opts = chatMock.mock.calls[0][1] as LLMOptions;
    expect(opts.tools?.map((t) => t.name)).not.toContain('escalate_to_human');
    // …and both prompt rungs that would promise a human dropped with it.
    const system = (chatMock.mock.calls[0][0] as ChatMessage[])[0].content as string;
    expect(system).not.toContain('## ESCALATION');
    expect(system).not.toContain('keeps insisting on booking');

    expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
    expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('bot');
  });

  it('a successful escalation survives a LATER provider failure — hands off once with escalation_trigger despite infraFailure', async () => {
    initializeAgentService(realAgent());
    const tenant = await makeTenant();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });

    // The tool call succeeds; the NEXT provider call dies with the exact quota
    // error of the 2026-08-03 outage (infraFailure — normally NO handoff).
    chatMock.mockResolvedValueOnce(callEscalate()).mockRejectedValueOnce(
      Object.assign(new Error('429 You have no credits remaining.'), {
        status: 429, code: 'credit_balance_exhausted', type: 'insufficient_quota',
      }),
    );
    const m1 = await makeTurn(tenant.id, session.id, user.id, 'Yes, connect me with a person');
    expect(await forwardMessageToN8n(session, m1)).toBe(true);

    // The explicit request WINS over the infraFailure no-handoff rule — once.
    const handoffs = await handoffRepo.find({ where: { sessionId: session.id } });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].reason).toBe('escalation_trigger');
    expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('handoff');
    // The customer still got a reply (the fallback), not silence.
    expect((await botMessages(session.id)).length).toBe(1);
  });

  it('control: a plain infra failure with NO escalation keeps the PR #106 behaviour — fallback, no handoff', async () => {
    initializeAgentService(realAgent());
    const tenant = await makeTenant();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });

    chatMock.mockRejectedValue(
      Object.assign(new Error('429 You have no credits remaining.'), {
        status: 429, code: 'credit_balance_exhausted', type: 'insufficient_quota',
      }),
    );
    const m1 = await makeTurn(tenant.id, session.id, user.id, 'hello');
    expect(await forwardMessageToN8n(session, m1)).toBe(true);

    expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
    expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('bot');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('escalation bridge — coalescer mapping (runTurn)', () => {
  async function coalescerSetup() {
    const tenant = await makeTenant();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    const m1 = await makeTurn(tenant.id, session.id, user.id, 'Yes, get me a human');
    await messageRepo.query(`UPDATE messages SET created_at = $1 WHERE id = $2`, [
      new Date(1_700_000_000_000), m1.id,
    ]);
    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    const pending = await getNewestUnansweredUserMessage(fresh);
    expect(pending?.id).toBe(m1.id);
    return { tenant, session, user, fresh, pending: pending! };
  }

  /** Insert a NEWER customer message (as if it landed mid-run). */
  async function insertNewerMessage(tenantId: string, sessionId: string, userId: string) {
    const late = await makeTurn(tenantId, sessionId, userId, 'Actually one more thing');
    await messageRepo.query(`UPDATE messages SET created_at = $1 WHERE id = $2`, [
      new Date(1_700_000_060_000), late.id,
    ]);
  }

  it('handoffRequested defeats the stale guard: one escalation_trigger handoff, turn stands', async () => {
    const { tenant, session, user, fresh, pending } = await coalescerSetup();
    initializeAgentService({
      run: vi.fn().mockImplementation(async () => {
        await insertNewerMessage(tenant.id, session.id, user.id); // lands mid-run
        return { type: 'response', content: 'Connecting you with a human now.', handoffRequested: true };
      }),
    } as unknown as AgentService);

    const status = await runTurn(fresh, pending);

    // NOT 'stale': the newer message must not roll back the turn that asked
    // for a person (matches the deterministic escalation-keyword path).
    expect(status).toBe('answered');
    const handoffs = await handoffRepo.find({ where: { sessionId: session.id } });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].reason).toBe('escalation_trigger');
    expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('handoff');
    expect(await botMessages(session.id)).toEqual(['Connecting you with a human now.']);
  });

  it('control: WITHOUT handoffRequested the same mid-run message makes the turn stale (no handoff)', async () => {
    const { tenant, session, user, fresh, pending } = await coalescerSetup();
    initializeAgentService({
      run: vi.fn().mockImplementation(async () => {
        await insertNewerMessage(tenant.id, session.id, user.id);
        return { type: 'response', content: 'Plain answer.' };
      }),
    } as unknown as AgentService);

    expect(await runTurn(fresh, pending)).toBe('stale');
    expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
  });

  it('handoffRequested wins over an infra error in the coalescer mapping too', async () => {
    const { session, fresh, pending } = await coalescerSetup();
    initializeAgentService({
      run: vi.fn().mockResolvedValue({
        type: 'error', error: 'provider down', fallbackMessage: 'One moment.',
        infraFailure: true, handoffRequested: true,
      }),
    } as unknown as AgentService);

    expect(await runTurn(fresh, pending)).toBe('answered');
    const handoffs = await handoffRepo.find({ where: { sessionId: session.id } });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].reason).toBe('escalation_trigger');
    expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('handoff');
  });

  it('control: an infra error WITHOUT handoffRequested still does not hand off (PR #106)', async () => {
    const { session, fresh, pending } = await coalescerSetup();
    initializeAgentService({
      run: vi.fn().mockResolvedValue({
        type: 'error', error: 'provider down', fallbackMessage: 'One moment.', infraFailure: true,
      }),
    } as unknown as AgentService);

    expect(await runTurn(fresh, pending)).toBe('answered');
    expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
    expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('bot');
  });
});
