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
import { Bot, BotSettings } from '../../database/entities/Bot';

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
