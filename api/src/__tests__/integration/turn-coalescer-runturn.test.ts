/**
 * Turn Coalescer — runTurn() Integration Tests
 *
 * Tests the correctness core of the message-burst coalescer (the part that the
 * approved plan, .scratch/plan-message-coalescer.md, spent 5 codex rounds on):
 *   - a burst is answered by EXACTLY ONE agent run, with the earlier messages
 *     riding along as history
 *   - the durable tuple watermark advances so the burst is then "answered"
 *   - stale-output suppression: a message that lands DURING the agent run is not
 *     answered by the now-stale reply and is NOT erased (it forms the next turn)
 *
 * The Bull/Redis scheduling + owner-token lock is covered by the computeDueAt
 * unit tests + design review; here we drive runTurn directly against a real DB
 * with mocked external boundaries (agent, socket, outbound router).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import {
  createTestTenant,
  createTestAnchorBot,
  createTestSession,
  createTestParticipant,
  createTestMessage,
} from '../helpers/factories';
import { BotSettings } from '../../database/entities/Bot';

// ── Mocks (same external boundaries as message-forwarding.test.ts) ───────────
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

const mockRouteOutboundMessage = vi.fn().mockResolvedValue({ success: true });
vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: (...args: unknown[]) => mockRouteOutboundMessage(...args),
  routeTypingIndicator: vi.fn().mockResolvedValue(undefined),
  sendChannelTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));

// ── Import SUT after mocks ───────────────────────────────────────────────────
import {
  runTurn,
  getNewestUnansweredUserMessage,
  getUnansweredBounds,
  initializeForwarding,
  initializeAgentService,
} from '../../services/message-forwarding.service';
import { OutboundService } from '../../n8n/outbound.service';
import { FallbackService } from '../../n8n/fallback.service';
import type { AgentService } from '../../agent/agent.service';

const sessionRepo = AppDataSource.getRepository(ChatSession);
const messageRepo = AppDataSource.getRepository(Message);

const AI = {
  enabled: true,
  provider: 'openai' as const,
  model: 'gpt-4o-mini',
  brandVoice: { name: 'TestBot', tone: 'friendly' as const, customInstructions: 'Be helpful.' },
  guardrails: {
    topicsToAvoid: [],
    escalationKeywords: [],
    confidenceThreshold: 0.5,
    maxResponseLength: 500,
    greetingMessage: 'Hi',
    fallbackMessage: 'Connecting you to a human.',
    offHoursMessage: 'Closed.',
  },
};

async function makeTenantWithAi() {
  const tenant = await createTestTenant({ settings: { ai: { apiKey: 'sk-test' } } as any });
  await createTestAnchorBot(tenant, { settings: { ai: AI } as BotSettings });
  return tenant;
}

/** Force a message's created_at so (created_at, id) ordering is deterministic. */
async function setCreatedAt(messageId: string, atMs: number): Promise<void> {
  await messageRepo.query(`UPDATE messages SET created_at = $1 WHERE id = $2`, [
    new Date(atMs),
    messageId,
  ]);
}

async function countBotMessages(sessionId: string): Promise<number> {
  return messageRepo
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .where('m.sessionId = :sid', { sid: sessionId })
    .andWhere("p.type = 'bot'")
    .getCount();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRouteOutboundMessage.mockReset().mockResolvedValue({ success: true });
  const fakeOutbound = { sendToWebhook: vi.fn() } as unknown as OutboundService;
  const fakeFallback = new FallbackService({
    eventEmitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), removeAllListeners: vi.fn() } as any,
  });
  initializeForwarding(fakeOutbound, fakeFallback);
});

afterEach(() => {
  initializeAgentService(null as unknown as AgentService);
});

describe('runTurn — burst coalescing', () => {
  it('answers a 3-message burst with ONE agent run and the earlier messages as history', async () => {
    const runMock = vi.fn().mockResolvedValue({ type: 'response', content: 'Got it, thanks!' });
    initializeAgentService({ run: runMock } as unknown as AgentService);

    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });

    const base = 1_700_000_000_000;
    const m1 = await createTestMessage(session.id, tenant.id, user.id, { content: 'Hi' });
    const m2 = await createTestMessage(session.id, tenant.id, user.id, { content: 'achraf@gmail.com' });
    const m3 = await createTestMessage(session.id, tenant.id, user.id, { content: '0475464421' });
    await setCreatedAt(m1.id, base);
    await setCreatedAt(m2.id, base + 1000);
    await setCreatedAt(m3.id, base + 2000);

    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    const pending = await getNewestUnansweredUserMessage(fresh);
    expect(pending?.id).toBe(m3.id); // newest unanswered is the live turn

    const status = await runTurn(fresh, pending!);

    expect(status).toBe('answered');
    expect(runMock).toHaveBeenCalledTimes(1);
    // history (4th arg) carries the two earlier burst messages, not the live turn
    const history = runMock.mock.calls[0][3] as { role: string; content: string }[];
    expect(history.map((h) => h.content)).toEqual(['Hi', 'achraf@gmail.com']);
    // exactly one bot reply, delivered once
    expect(await countBotMessages(session.id)).toBe(1);
    expect(mockRouteOutboundMessage).toHaveBeenCalledTimes(1);

    // watermark advanced to the consumed hwm → nothing left unanswered
    const after = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    expect(after.lastCoalescedAnswerMessageId).toBe(m3.id);
    expect(await getNewestUnansweredUserMessage(after)).toBeNull();
  });
});

describe('runTurn — watermark compared DB-side (re-arm storm regression)', () => {
  // The watermark advance (finalizeReply) reads created_at DB-side with full µs
  // precision, but the read side used to compare against session.lastCoalescedAnswerAt
  // — a JS Date (ms precision). In prod (created_at is timestamptz/µs) that truncates
  // sub-ms µs, so the just-answered watermark message re-qualified as "unanswered"
  // and the coalescer re-ran the agent on it every ~500ms forever (the 429/TPM storm).
  // The reads must key off the watermark *message id* and read its created_at DB-side,
  // independent of the stored JS Date. Asserting that here: the stored date is stale,
  // but the message-id watermark is the newest message → nothing is unanswered.
  it('treats the newest message as answered from the id watermark, ignoring a stale lastCoalescedAnswerAt', async () => {
    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });

    const base = 1_700_000_000_000;
    const m1 = await createTestMessage(session.id, tenant.id, user.id, { content: 'Hi' });
    const m2 = await createTestMessage(session.id, tenant.id, user.id, { content: 'there' });
    await setCreatedAt(m1.id, base);
    await setCreatedAt(m2.id, base + 1000);

    // m2 IS the answered high-water mark, but the stored timestamp is stale/imprecise
    // (an hour behind — standing in for the sub-ms truncation a JS Date causes).
    await sessionRepo.query(
      `UPDATE chat_sessions SET last_coalesced_answer_message_id = $1, last_coalesced_answer_at = $2 WHERE id = $3`,
      [m2.id, new Date(base + 1000 - 3_600_000), session.id],
    );

    const after = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    expect(after.lastCoalescedAnswerMessageId).toBe(m2.id);
    // DB-side compare reads m2's real created_at via its id → m2 is not > itself → null.
    // (Old JS-Date compare used the stale stored date → re-selected m2 → infinite re-arm.)
    expect(await getNewestUnansweredUserMessage(after)).toBeNull();
    expect(await getUnansweredBounds(after)).toBeNull();
  });

  it('falls back to the stored date when the watermark message was hard-deleted (no stall)', async () => {
    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });

    const base = 1_700_000_000_000;
    const m1 = await createTestMessage(session.id, tenant.id, user.id, { content: 'old' });
    const m2 = await createTestMessage(session.id, tenant.id, user.id, { content: 'new' });
    await setCreatedAt(m1.id, base);
    await setCreatedAt(m2.id, base + 1000);

    // Watermark id points at a message that no longer exists (hard-deleted), but the
    // session still has the stored date between m1 and m2. The DB-side subquery
    // returns NULL → without COALESCE every message looks answered (silent stall).
    await sessionRepo.query(
      `UPDATE chat_sessions SET last_coalesced_answer_message_id = $1, last_coalesced_answer_at = $2 WHERE id = $3`,
      ['00000000-0000-0000-0000-000000000000', new Date(base + 500), session.id],
    );

    const after = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    // COALESCE falls back to the stored date (base+500): m1 (base) is answered, m2
    // (base+1000) is still unanswered → returned, not a stall.
    const pending = await getNewestUnansweredUserMessage(after);
    expect(pending?.id).toBe(m2.id);
    expect((await getUnansweredBounds(after))?.count).toBe(1);
  });
});

describe('runTurn — greeting excluded from agent history', () => {
  it('drops the leading bot greeting so it cannot anchor the reply language', async () => {
    const runMock = vi.fn().mockResolvedValue({ type: 'response', content: 'Sure, I can help.' });
    initializeAgentService({ run: runMock } as unknown as AgentService);

    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    const botp = await createTestParticipant(session.id, { type: 'bot', name: 'Bot' });

    const base = 1_700_000_000_000;
    // Static configured greeting (Dutch) sent at init, BEFORE the customer's turn.
    const greeting = await createTestMessage(session.id, tenant.id, botp.id, {
      content: 'Welkom, waar kan ik je mee van dienst zijn?',
    });
    const userMsg = await createTestMessage(session.id, tenant.id, user.id, {
      content: 'do you have availability this weekend?',
    });
    await setCreatedAt(greeting.id, base);
    await setCreatedAt(userMsg.id, base + 1000);

    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    const pending = await getNewestUnansweredUserMessage(fresh);
    expect(pending?.id).toBe(userMsg.id);

    await runTurn(fresh, pending!);

    const history = runMock.mock.calls[0][3] as { role: string; content: string }[];
    // The Dutch greeting must NOT be fed to the model (it would anchor the reply
    // language on turn 1). Turn 1 → history is empty (only the greeting preceded).
    expect(history.some((h) => h.content.includes('Welkom'))).toBe(false);
    expect(history).toEqual([]);
  });

  it('keeps a leading assistant turn when older history exists (window starts mid-conversation)', async () => {
    const runMock = vi.fn().mockResolvedValue({ type: 'response', content: 'ok' });
    initializeAgentService({ run: runMock } as unknown as AgentService);

    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    const botp = await createTestParticipant(session.id, { type: 'bot', name: 'Bot' });

    const base = 1_700_000_000_000;
    // 11 non-hwm messages → the 10-message window excludes the oldest and starts on
    // a real bot turn (b1) that must NOT be trimmed (it isn't the greeting).
    const uOld = await createTestMessage(session.id, tenant.id, user.id, { content: 'oldest user' });
    await setCreatedAt(uOld.id, base);
    let t = base + 1;
    for (let i = 1; i <= 5; i++) {
      const b = await createTestMessage(session.id, tenant.id, botp.id, { content: `bot ${i}` });
      await setCreatedAt(b.id, t++);
      const u = await createTestMessage(session.id, tenant.id, user.id, { content: `user ${i}` });
      await setCreatedAt(u.id, t++);
    }
    const hwm = await createTestMessage(session.id, tenant.id, user.id, { content: 'live question' });
    await setCreatedAt(hwm.id, t++);

    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    const pending = await getNewestUnansweredUserMessage(fresh);
    expect(pending?.id).toBe(hwm.id);
    await runTurn(fresh, pending!);

    const history = runMock.mock.calls[0][3] as { role: string; content: string }[];
    expect(history).toHaveLength(10); // window cap
    expect(history[0]).toEqual({ role: 'assistant', content: 'bot 1' }); // leading bot turn kept
    expect(history.some((h) => h.content === 'oldest user')).toBe(false); // oldest beyond the window
  });
});

describe('runTurn — stale-output suppression', () => {
  it('discards the reply when a newer message lands DURING the run, and keeps that message', async () => {
    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });

    const base = 1_700_000_000_000;
    const email = await createTestMessage(session.id, tenant.id, user.id, { content: 'achraf@gmail.com' });
    await setCreatedAt(email.id, base);

    // The agent "thinks", and while it does the customer sends their phone number.
    const runMock = vi.fn().mockImplementation(async () => {
      const phone = await createTestMessage(session.id, tenant.id, user.id, { content: '0475464421' });
      await setCreatedAt(phone.id, base + 1500);
      return { type: 'response', content: 'What is your phone number?' };
    });
    initializeAgentService({ run: runMock } as unknown as AgentService);

    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    const pending = await getNewestUnansweredUserMessage(fresh);
    expect(pending?.id).toBe(email.id);

    const status = await runTurn(fresh, pending!);

    expect(status).toBe('stale');
    // the stale "what's your phone?" reply was NOT persisted or delivered
    expect(await countBotMessages(session.id)).toBe(0);
    expect(mockRouteOutboundMessage).not.toHaveBeenCalled();
    // watermark NOT advanced — both the email and the phone are still unanswered
    const after = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    expect(after.lastCoalescedAnswerAt == null).toBe(true);
    const stillPending = await getNewestUnansweredUserMessage(after);
    expect(stillPending?.content).toBe('0475464421');
  });
});
