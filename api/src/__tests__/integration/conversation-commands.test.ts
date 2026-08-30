/**
 * Conversation Command Service + routes + AI fence (B-PR2b) — Integration Tests
 *
 * The transaction/concurrency core of the pilot Inbox plan (§B1/B2/B6):
 *   - two concurrent claims: exactly one winner, one stable
 *     `conversation_already_claimed` conflict
 *   - claim → release → re-claim ABA, and idempotent replay (same key → same
 *     result, no double-apply) for claim/release/cancel/close
 *   - requestHandoff creates ONE open HandoffRequest and moves ownership;
 *     a `handoffEnabled: false` bot creates none
 *   - cancelHandoff is an ATOMIC HANDOFF_REQUESTED -> BOT_OWNED transition
 *   - sendHumanMessage auto-claims, dedupes by clientMessageId, and 409s a
 *     second operator (keep-draft)
 *   - the AI finalization fence: an in-flight run whose ownership_version moved
 *     (even a claim→release ABA that lands back on status 'bot') must NOT
 *     commit its reply — on the coalescer AND the legacy path
 *   - ownership <-> legacy status stay consistent after every command
 *
 * Real DB; mocked external boundaries (sockets, outbound router, localization,
 * agent service) — the same seams the coalescer/forwarding suites mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

const redisClient = vi.hoisted(() => ({
  live: true,
}));

vi.mock('../../config/redis', () => {
  const client = {
    del: async () => 0,
    get: async () => null,
    set: async () => 'OK',
    ping: async () => 'PONG',
    on: () => undefined,
    quit: async () => undefined,
  };
  return {
    getRedisClient: () => (redisClient.live ? client : null),
    getPubClient: () => (redisClient.live ? client : null),
    getSubClient: () => (redisClient.live ? client : null),
    initializeRedis: async () => undefined,
    isRedisAvailable: () => redisClient.live,
    getRedisAdapterOptions: () => ({
      pubClient: redisClient.live ? client : null,
      subClient: redisClient.live ? client : null,
    }),
    closeRedis: async () => undefined,
  };
});

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
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

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
import { NotificationOutbox } from '../../database/entities/NotificationOutbox';
import { Agent } from '../../database/entities/Agent';
import { BotSettings } from '../../database/entities/Bot';
import {
  createTestTenant,
  createTestAnchorBot,
  createTestUser,
  createTestAgent,
  createTestSession,
  createTestParticipant,
  createTestMessage,
  createTestHandoffRequest,
} from '../helpers/factories';
import {
  conversationCommands,
  ConversationAlreadyClaimedError,
} from '../../services/conversation-command.service';
import {
  forwardMessageToN8n,
  runTurn,
  getNewestUnansweredUserMessage,
  initializeAgentService,
} from '../../services/message-forwarding.service';
import type { AgentService } from '../../agent/agent.service';
import { ingestWidgetCustomerMessage } from '../../services/widget-ingest';
import { releaseAgentSessions } from '../../utils/releaseAgentSessions';
import { CreateConversationCommands1791400000000 } from '../../database/migrations/1791400000000-CreateConversationCommands';
import { emitToSession } from '../../websocket/socket.handler';

const sessionRepo = AppDataSource.getRepository(ChatSession);
const messageRepo = AppDataSource.getRepository(Message);
const handoffRepo = AppDataSource.getRepository(HandoffRequest);
const outboxRepo = AppDataSource.getRepository(NotificationOutbox);
const agentRepo = AppDataSource.getRepository(Agent);

const AI = {
  enabled: true,
  provider: 'openai' as const,
  model: 'gpt-4o-mini',
  brandVoice: { name: 'TestBot', tone: 'friendly' as const },
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

async function makeTenantWithAi(features?: BotSettings['features']) {
  const tenant = await createTestTenant({ settings: { ai: { apiKey: 'sk-test' } } as never });
  await createTestAnchorBot(tenant, {
    settings: { ai: AI, ...(features ? { features } : {}) } as BotSettings,
  });
  return tenant;
}

async function makeOperator(tenantId: string) {
  const user = await createTestUser(tenantId, { role: 'admin' });
  const agent = await createTestAgent(tenantId, user.id);
  return { user, agent };
}

/** Both columns, raw, so a desync between ownership and legacy status is caught. */
async function stateOf(sessionId: string) {
  const [row] = await AppDataSource.query(
    `SELECT ownership, status, ownership_version, assigned_agent_id,
            human_control_mode, human_control_until
       FROM chat_sessions WHERE id = $1`,
    [sessionId],
  );
  return row as {
    ownership: string;
    status: string;
    ownership_version: number;
    assigned_agent_id: string | null;
    human_control_mode: string | null;
    human_control_until: string | null;
  };
}

async function countBotTextMessages(sessionId: string): Promise<number> {
  return messageRepo
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .where('m.sessionId = :sid', { sid: sessionId })
    .andWhere("p.type = 'bot'")
    .getCount();
}

beforeEach(() => {
  vi.clearAllMocks();
  redisClient.live = true;
  mockRouteOutboundMessage.mockReset().mockResolvedValue({ success: true });
});

afterEach(() => {
  initializeAgentService(null as unknown as AgentService);
});

// ═════════════════════════════════════════════════════════════════════════════

describe('claimConversation — concurrency and ABA', () => {
  it('two concurrent claims: exactly one winner, one conversation_already_claimed', async () => {
    const tenant = await makeTenantWithAi();
    const a = await makeOperator(tenant.id);
    const b = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'handoff', ownership: 'handoff_requested' });
    const handoff = await createTestHandoffRequest(session.id, tenant.id);

    const results = await Promise.allSettled([
      conversationCommands.claimConversation(session.id, a.agent.id, { mode: 'indefinite' }),
      conversationCommands.claimConversation(session.id, b.agent.id, { mode: 'indefinite' }),
    ]);

    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0].reason).toBeInstanceOf(ConversationAlreadyClaimedError);
    expect((losses[0].reason as ConversationAlreadyClaimedError).code).toBe('conversation_already_claimed');

    const state = await stateOf(session.id);
    expect(state.ownership).toBe('human_owned');
    expect(state.status).toBe('handoff'); // derived legacy status stays in sync
    expect([a.agent.id, b.agent.id]).toContain(state.assigned_agent_id);
    expect(state.human_control_mode).toBe('indefinite');

    // The one open handoff was accepted exactly once, by the winner.
    const updated = await handoffRepo.findOneOrFail({ where: { id: handoff.id } });
    expect(updated.status).toBe('accepted');
    expect(updated.assignedAgentId).toBe(state.assigned_agent_id);
  });

  it('claim → release → re-claim (ABA) works, and every step keeps ownership<->status consistent', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const v0 = (await stateOf(session.id)).ownership_version;

    await conversationCommands.claimConversation(session.id, agent.id, { mode: 'indefinite' });
    let s = await stateOf(session.id);
    expect(s).toMatchObject({ ownership: 'human_owned', status: 'handoff', assigned_agent_id: agent.id });
    expect(s.ownership_version).toBe(v0 + 1);

    await conversationCommands.releaseConversation(session.id, agent.id);
    s = await stateOf(session.id);
    expect(s).toMatchObject({
      ownership: 'bot_owned',
      status: 'bot', // back on a status the AI pipeline actually serves
      assigned_agent_id: null,
      human_control_mode: null,
    });
    expect(s.ownership_version).toBe(v0 + 2);

    const again = await conversationCommands.claimConversation(session.id, agent.id, { mode: 'indefinite' });
    expect(again.outcome).toBe('claimed');
    s = await stateOf(session.id);
    expect(s).toMatchObject({ ownership: 'human_owned', status: 'handoff', assigned_agent_id: agent.id });
    expect(s.ownership_version).toBe(v0 + 3);
  });

  it('idempotent replay: the same key returns the same result and never double-applies', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });

    const first = await conversationCommands.claimConversation(
      session.id, agent.id, { mode: 'indefinite' }, 'claim-key-1', { tenantId: tenant.id },
    );
    const afterFirst = await stateOf(session.id);
    const chatCountAfterFirst = (await agentRepo.findOneOrFail({ where: { id: agent.id } })).currentChatCount;
    // S2: a claim never touches currentChatCount (nothing ever decremented it).
    expect(chatCountAfterFirst).toBe(0);

    const replayed = await conversationCommands.claimConversation(
      session.id, agent.id, { mode: 'indefinite' }, 'claim-key-1', { tenantId: tenant.id },
    );
    expect(replayed.replayed).toBe(true);
    expect(replayed.outcome).toBe(first.outcome);
    expect(replayed.conversation).toEqual(first.conversation);

    // No double-apply: version and chat count did not move again.
    const afterReplay = await stateOf(session.id);
    expect(afterReplay.ownership_version).toBe(afterFirst.ownership_version);
    expect((await agentRepo.findOneOrFail({ where: { id: agent.id } })).currentChatCount).toBe(chatCountAfterFirst);

    // release / close replay the same way.
    const rel1 = await conversationCommands.releaseConversation(session.id, agent.id, 'rel-key-1');
    const rel2 = await conversationCommands.releaseConversation(session.id, agent.id, 'rel-key-1');
    expect(rel2.replayed).toBe(true);
    expect(rel2.conversation).toEqual(rel1.conversation);
    expect((await stateOf(session.id)).ownership_version).toBe(afterFirst.ownership_version + 1);

    const close1 = await conversationCommands.closeConversation(session.id, { kind: 'agent', agentId: agent.id }, 'close-key-1');
    const close2 = await conversationCommands.closeConversation(session.id, { kind: 'agent', agentId: agent.id }, 'close-key-1');
    expect(close2.replayed).toBe(true);
    expect(close2.conversation).toEqual(close1.conversation);
    const closed = await stateOf(session.id);
    expect(closed).toMatchObject({ ownership: 'closed', status: 'closed' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('requestHandoff / cancelHandoff', () => {
  it('bot-path requestHandoff creates ONE handoff, moves ownership, and dedupes a second request', async () => {
    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const botp = await createTestParticipant(session.id, { type: 'bot', name: 'Bot' });

    const first = await conversationCommands.requestHandoff(
      session.id, 'escalation_trigger', 'bot', undefined, { requestedBy: botp.id },
    );
    expect(first.outcome).toBe('requested');
    expect(first.handoffId).toBeTruthy();

    const s = await stateOf(session.id);
    expect(s).toMatchObject({ ownership: 'handoff_requested', status: 'handoff' });

    const rows = await handoffRepo.find({ where: { sessionId: session.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('escalation_trigger');
    expect(rows[0].status).toBe('requested');

    // Duplicate request converges on the SAME open handoff — no second row.
    const second = await conversationCommands.requestHandoff(
      session.id, 'user_request', 'widget', undefined, {},
    );
    expect(second.outcome).toBe('already_requested');
    expect(second.handoffId).toBe(first.handoffId);
    expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(1);
  });

  it('writes a pending notification-outbox row atomically ONLY when notify is set (ADR-0018)', async () => {
    const tenant = await makeTenantWithAi();

    // Default (no notify): the handoff is created but no outbox row — behaviour unchanged.
    const quiet = await createTestSession(tenant.id, { status: 'bot' });
    const noNotify = await conversationCommands.requestHandoff(quiet.id, 'user_request', 'widget', undefined, {});
    expect(noNotify.outcome).toBe('requested');
    expect(await outboxRepo.count({ where: { relatedId: noNotify.handoffId! } })).toBe(0);

    // notify: true — one pending outbox row, in the same transaction as the handoff.
    const loud = await createTestSession(tenant.id, { status: 'bot' });
    const notified = await conversationCommands.requestHandoff(
      loud.id, 'user_request', 'widget', undefined, { notify: true },
    );
    const rows = await outboxRepo.find({ where: { relatedId: notified.handoffId! } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'handoff', status: 'pending', tenantId: tenant.id });
    expect(rows[0].payload).toMatchObject({ handoffId: notified.handoffId, sessionId: loud.id, reason: 'user_request' });
  });

  it('a handoffEnabled:false bot creates NO handoff and does not move ownership', async () => {
    const tenant = await makeTenantWithAi({ fileUploadEnabled: true, handoffEnabled: false });
    const session = await createTestSession(tenant.id, { status: 'bot' });

    const result = await conversationCommands.requestHandoff(session.id, 'user_request', 'widget');
    expect(result.outcome).toBe('handoff_disabled');
    expect(result.handoffId).toBeNull();

    expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
    const s = await stateOf(session.id);
    expect(s).toMatchObject({ ownership: 'bot_owned', status: 'bot', ownership_version: 0 });
  });

  it('cancelHandoff atomically returns HANDOFF_REQUESTED -> BOT_OWNED and times out the open row (sweep actor)', async () => {
    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'handoff', ownership: 'handoff_requested' });
    const handoff = await createTestHandoffRequest(session.id, tenant.id);
    const v0 = (await stateOf(session.id)).ownership_version;

    const result = await conversationCommands.cancelHandoff(
      session.id, { kind: 'system', source: 'stale_handoff_sweep' },
    );
    expect(result.outcome).toBe('cancelled');

    const s = await stateOf(session.id);
    expect(s).toMatchObject({ ownership: 'bot_owned', status: 'bot', assigned_agent_id: null });
    expect(s.ownership_version).toBe(v0 + 1);
    expect((await handoffRepo.findOneOrFail({ where: { id: handoff.id } })).status).toBe('timeout');

    // Re-entrant: a second cancel is a no-op success, not an error.
    const again = await conversationCommands.cancelHandoff(session.id, { kind: 'system' });
    expect(again.outcome).toBe('already_bot_owned');
    expect((await stateOf(session.id)).ownership_version).toBe(v0 + 1);
  });

  it('an operator decline marks the row rejected (not timeout)', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'handoff', ownership: 'handoff_requested' });
    const handoff = await createTestHandoffRequest(session.id, tenant.id);

    await conversationCommands.cancelHandoff(
      session.id, { kind: 'agent', agentId: agent.id }, undefined, { tenantId: tenant.id, reason: 'Not available' },
    );
    const row = await handoffRepo.findOneOrFail({ where: { id: handoff.id } });
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('Not available');
    expect(await stateOf(session.id)).toMatchObject({ ownership: 'bot_owned', status: 'bot' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('sendHumanMessage — auto-claim + dedupe + conflict', () => {
  it('auto-claims an unclaimed conversation in the same transaction and dedupes by clientMessageId', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });

    const first = await conversationCommands.sendHumanMessage(
      session.id, agent.id, 'cmid-1', 'Hello, a human here', { tenantId: tenant.id },
    );
    expect(first.outcome).toBe('sent');
    expect(first.autoClaimed).toBe(true);

    const s = await stateOf(session.id);
    expect(s).toMatchObject({
      ownership: 'human_owned',
      status: 'handoff',
      assigned_agent_id: agent.id,
      human_control_mode: 'indefinite', // operator default policy until PR 5
    });

    // Retry with the same clientMessageId: the ORIGINAL message, no second row.
    const dup = await conversationCommands.sendHumanMessage(
      session.id, agent.id, 'cmid-1', 'Hello, a human here', { tenantId: tenant.id },
    );
    expect(dup.outcome).toBe('duplicate');
    expect(dup.message.id).toBe(first.message.id);

    const humanMessages = await AppDataSource.query(
      `SELECT id FROM messages WHERE session_id = $1 AND metadata->>'clientMessageId' = 'cmid-1'`,
      [session.id],
    );
    expect(humanMessages).toHaveLength(1);
  });

  it("a second operator's reply is a 409 conversation_already_claimed (keep-draft)", async () => {
    const tenant = await makeTenantWithAi();
    const a = await makeOperator(tenant.id);
    const b = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });

    await conversationCommands.sendHumanMessage(session.id, a.agent.id, 'a-1', 'mine now', { tenantId: tenant.id });

    await expect(
      conversationCommands.sendHumanMessage(session.id, b.agent.id, 'b-1', 'my draft', { tenantId: tenant.id }),
    ).rejects.toBeInstanceOf(ConversationAlreadyClaimedError);

    // The loser's draft was NOT persisted.
    const rows = await AppDataSource.query(
      `SELECT id FROM messages WHERE session_id = $1 AND metadata->>'clientMessageId' = 'b-1'`,
      [session.id],
    );
    expect(rows).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('REST command routes', () => {
  it('POST /takeover claims (indefinite), replays on the same key, and 409s a second operator', async () => {
    const tenant = await makeTenantWithAi();
    const a = await makeOperator(tenant.id);
    const b = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'handoff', ownership: 'handoff_requested' });
    await createTestHandoffRequest(session.id, tenant.id);

    configureMockAuth(auth, { userId: a.agent.id, tenantId: tenant.id, role: 'admin' });
    const res = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ idempotencyKey: 'tk-1', mode: 'indefinite' });
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('claimed');
    expect(res.body.data.conversation).toMatchObject({
      ownership: 'human_owned',
      assignedAgentId: a.agent.id,
      humanControlMode: 'indefinite',
    });

    // Same key → replayed, same committed result.
    const retry = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ idempotencyKey: 'tk-1', mode: 'indefinite' });
    expect(retry.status).toBe(200);
    expect(retry.body.data.conversation).toEqual(res.body.data.conversation);

    // Another operator: stable 409 with the machine-readable code.
    configureMockAuth(auth, { userId: b.agent.id, tenantId: tenant.id, role: 'admin' });
    const conflict = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ idempotencyKey: 'tk-2', mode: 'indefinite' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('conversation_already_claimed');
  });

  it('POST /takeover accepts mode timed now that the expiry worker exists (B-PR5a), and validates hours', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    const invalid = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ idempotencyKey: 'tk-bad', mode: 'timed', hours: 25 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('invalid_takeover_hours');

    const timed = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ idempotencyKey: 'tk-t', mode: 'timed', hours: 2 });
    expect(timed.status).toBe(200);
    expect(timed.body.data.outcome).toBe('claimed');
    expect(timed.body.data.conversation).toMatchObject({
      ownership: 'human_owned',
      humanControlMode: 'timed',
      humanControlDurationHours: 2,
    });
    expect(timed.body.data.conversation.humanControlUntil).toBeTruthy();
  });

  it('B2 compat: the SHIPPED portal posts takeover/close/release with an EMPTY body — they must work (non-idempotently)', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    // Inbox.tsx:198 — Take Over sends no body: defaults to an indefinite claim.
    const takeover = await request(app).post(`/api/v1/chats/${session.id}/takeover`).send({});
    expect(takeover.status).toBe(200);
    expect(takeover.body.data.outcome).toBe('claimed');
    expect(takeover.body.data.conversation.humanControlMode).toBe('indefinite');

    // Inbox.tsx:289 — Return to Bot sends no body.
    const release = await request(app).post(`/api/v1/chats/${session.id}/release`).send({});
    expect(release.status).toBe(200);
    expect(release.body.data.conversation).toMatchObject({ ownership: 'bot_owned', status: 'bot' });

    // Inbox.tsx:272 — Close sends no body.
    const close = await request(app).post(`/api/v1/chats/${session.id}/close`).send({});
    expect(close.status).toBe(200);
    expect(await stateOf(session.id)).toMatchObject({ ownership: 'closed', status: 'closed' });

    // No idempotency rows were written for keyless commands.
    const rows = await AppDataSource.query(
      `SELECT id FROM conversation_commands WHERE session_id = $1`,
      [session.id],
    );
    expect(rows).toHaveLength(0);

    // /cancel has no shipped caller and stays strict.
    const s2 = await createTestSession(tenant.id, { status: 'handoff', ownership: 'handoff_requested' });
    const cancelNoKey = await request(app).post(`/api/v1/chats/${s2.id}/cancel`).send({});
    expect(cancelNoKey.status).toBe(400);
  });

  it('POST /transfer replays idempotently, supports keyless calls, and validates present keys', async () => {
    const tenant = await makeTenantWithAi();
    const source = await makeOperator(tenant.id);
    const target = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    configureMockAuth(auth, { userId: source.agent.id, tenantId: tenant.id, role: 'admin' });

    const first = await request(app)
      .post(`/api/v1/chats/${session.id}/transfer`)
      .send({ agentId: target.agent.id, idempotencyKey: 'xfer-1' });
    expect(first.status).toBe(200);
    expect(first.body.data.session.assignedAgentId).toBe(target.agent.id);

    const retry = await request(app)
      .post(`/api/v1/chats/${session.id}/transfer`)
      .send({ agentId: target.agent.id, idempotencyKey: 'xfer-1' });
    expect(retry.status).toBe(200);
    expect(retry.body.data).toEqual(first.body.data);

    const keyedRows = await AppDataSource.query(
      `SELECT id FROM conversation_commands
        WHERE session_id = $1 AND command = 'transfer'`,
      [session.id],
    );
    expect(keyedRows).toHaveLength(1);

    const keyless = await request(app)
      .post(`/api/v1/chats/${session.id}/transfer`)
      .send({ agentId: source.agent.id });
    expect(keyless.status).toBe(200);
    expect(keyless.body.data.session.assignedAgentId).toBe(source.agent.id);

    const rowsAfterKeyless = await AppDataSource.query(
      `SELECT id FROM conversation_commands
        WHERE session_id = $1 AND command = 'transfer'`,
      [session.id],
    );
    expect(rowsAfterKeyless).toHaveLength(1);

    const invalid = await request(app)
      .post(`/api/v1/chats/${session.id}/transfer`)
      .send({ agentId: target.agent.id, idempotencyKey: '' });
    expect(invalid.status).toBe(400);
  });

  it('POST /messages sends + auto-claims; /release and /close complete the lifecycle', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    const sent = await request(app)
      .post(`/api/v1/chats/${session.id}/messages`)
      .send({ clientMessageId: 'route-m1', content: 'Operator here' });
    expect(sent.status).toBe(201);
    expect(sent.body.data.outcome).toBe('sent');
    expect(sent.body.data.autoClaimed).toBe(true);

    const dup = await request(app)
      .post(`/api/v1/chats/${session.id}/messages`)
      .send({ clientMessageId: 'route-m1', content: 'Operator here' });
    expect(dup.status).toBe(201);
    expect(dup.body.data.outcome).toBe('duplicate');
    expect(dup.body.data.message.id).toBe(sent.body.data.message.id);

    const released = await request(app)
      .post(`/api/v1/chats/${session.id}/release`)
      .send({ idempotencyKey: 'rel-1' });
    expect(released.status).toBe(200);
    expect(released.body.data.conversation).toMatchObject({ ownership: 'bot_owned', status: 'bot' });

    const closed = await request(app)
      .post(`/api/v1/chats/${session.id}/close`)
      .send({ idempotencyKey: 'close-1' });
    expect(closed.status).toBe(200);
    expect(await stateOf(session.id)).toMatchObject({ ownership: 'closed', status: 'closed' });
  });

  it('POST /cancel returns a pending handoff to the bot', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'handoff', ownership: 'handoff_requested' });
    await createTestHandoffRequest(session.id, tenant.id);
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/chats/${session.id}/cancel`)
      .send({ idempotencyKey: 'cx-1' });
    expect(res.status).toBe(200);
    expect(res.body.data.conversation).toMatchObject({ ownership: 'bot_owned', status: 'bot' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('REST super-admin reset', () => {
  it('POST /reset is forbidden for a tenant admin', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot', channel: 'whatsapp', source: 'whatsapp' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    const denied = await request(app).post(`/api/v1/chats/${session.id}/reset`).send({});
    expect(denied.status).toBe(403);
    expect(await stateOf(session.id)).toMatchObject({ ownership: 'bot_owned', status: 'bot' });
  });

  it('POST /reset closes the session for a super admin', async () => {
    const tenant = await makeTenantWithAi();
    const user = await createTestUser(tenant.id, { role: 'super_admin' });
    const agent = await createTestAgent(tenant.id, user.id);
    const session = await createTestSession(tenant.id, { status: 'bot', channel: 'whatsapp', source: 'whatsapp' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'super_admin' });

    const res = await request(app)
      .post(`/api/v1/chats/${session.id}/reset`)
      .send({ idempotencyKey: 'reset-1' });
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('reset');
    expect(res.body.data.scratchCleared).toBe(true);
    expect(await stateOf(session.id)).toMatchObject({ ownership: 'closed', status: 'closed' });
  });

  it('POST /reset returns 503 reset_scratch_incomplete when Redis client is missing', async () => {
    const tenant = await makeTenantWithAi();
    const user = await createTestUser(tenant.id, { role: 'super_admin' });
    const agent = await createTestAgent(tenant.id, user.id);
    const session = await createTestSession(tenant.id, { status: 'bot', channel: 'whatsapp', source: 'whatsapp' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'super_admin' });

    redisClient.live = false;
    const res = await request(app)
      .post(`/api/v1/chats/${session.id}/reset`)
      .send({ idempotencyKey: 'reset-null-redis' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('reset_scratch_incomplete');
    expect(res.body.error.details.conversation).toMatchObject({
      sessionId: session.id,
      ownership: 'closed',
      status: 'closed',
    });
    expect(await stateOf(session.id)).toMatchObject({ ownership: 'closed', status: 'closed' });
    expect(emitToSession).toHaveBeenCalledWith(
      tenant.id,
      session.id,
      'session:closed',
      expect.objectContaining({ sessionId: session.id, closedBy: 'agent' }),
    );
    expect(emitToSession).toHaveBeenCalledWith(
      tenant.id,
      session.id,
      'conversation:upsert',
      expect.objectContaining({
        conversation: expect.objectContaining({ id: session.id, status: 'closed' }),
      }),
    );
  });
});

describe('AI finalization fence — ownership_version', () => {
  it('coalescer: a claim→release ABA mid-run (status back on bot) still voids the in-flight reply', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    const msg = await createTestMessage(session.id, tenant.id, user.id, { content: 'hello?' });

    // While the LLM "thinks", a human claims AND releases: status ends back on
    // 'bot' with AI enabled, so the pre-fence commit predicate would pass — only
    // the ownership_version check catches the ABA.
    const runMock = vi.fn().mockImplementation(async () => {
      await conversationCommands.claimConversation(session.id, agent.id, { mode: 'indefinite' });
      await conversationCommands.releaseConversation(session.id, agent.id);
      return { type: 'response', content: 'A stale answer.' };
    });
    initializeAgentService({ run: runMock } as unknown as AgentService);

    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    const pending = await getNewestUnansweredUserMessage(fresh);
    expect(pending?.id).toBe(msg.id);

    expect(await runTurn(fresh, pending!)).toBe('stale');
    expect(await countBotTextMessages(session.id)).toBe(0);
    expect(mockRouteOutboundMessage).not.toHaveBeenCalled();
    // status is 'bot' again, but the reply did not land and the turn is not
    // marked answered (it re-runs against the post-release conversation).
    const after = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    expect(after.status).toBe('bot');
    expect(after.lastCoalescedAnswerAt == null).toBe(true);
  });

  it('coalescer: a human claim mid-run suppresses the reply (version + status both moved)', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    const msg = await createTestMessage(session.id, tenant.id, user.id, { content: 'anyone there?' });

    initializeAgentService({
      run: vi.fn().mockImplementation(async () => {
        await conversationCommands.claimConversation(session.id, agent.id, { mode: 'indefinite' });
        return { type: 'response', content: 'I am a bot!' };
      }),
    } as unknown as AgentService);

    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    expect(await runTurn(fresh, msg)).toBe('stale');
    expect(await countBotTextMessages(session.id)).toBe(0);
    expect(await stateOf(session.id)).toMatchObject({ ownership: 'human_owned', status: 'handoff' });
  });

  it('legacy path: a claim mid-run suppresses the reply and the follow-up handoff', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    const msg = await createTestMessage(session.id, tenant.id, user.id, { content: 'hi' });

    initializeAgentService({
      run: vi.fn().mockImplementation(async () => {
        await conversationCommands.claimConversation(session.id, agent.id, { mode: 'indefinite' });
        return { type: 'response', content: 'Too late.' };
      }),
    } as unknown as AgentService);

    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    expect(await forwardMessageToN8n(fresh, msg)).toBe(true);

    expect(await countBotTextMessages(session.id)).toBe(0);
    expect(await stateOf(session.id)).toMatchObject({
      ownership: 'human_owned',
      status: 'handoff',
      assigned_agent_id: agent.id,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('review fix round — stale-save clobber (B1) and releaseAgentSessions (B3)', () => {
  it('B1: a message ingest holding a STALE session entity cannot revert a committed takeover', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });

    // t0: the ingress path loads the session (bot_owned, v0).
    const staleEntity = await sessionRepo.findOneOrFail({ where: { id: session.id } });

    // t1: a human claims — ownership/status/version move.
    await conversationCommands.claimConversation(session.id, agent.id, { mode: 'indefinite' });
    const afterClaim = await stateOf(session.id);
    expect(afterClaim.ownership).toBe('human_owned');

    // t2: the customer's message lands through the ingest path with the STALE
    // entity. Before the fix this save(session) wrote back ownership='bot_owned',
    // the old version, and status='bot' — undoing the takeover and re-arming the
    // AI fence with a stale base.
    const countBefore = staleEntity.messageCount ?? 0; // ingest mutates the in-memory copy
    await ingestWidgetCustomerMessage(staleEntity, 'hello, are you a person?');

    const after = await stateOf(session.id);
    expect(after).toMatchObject({
      ownership: 'human_owned',
      status: 'handoff',
      assigned_agent_id: agent.id,
    });
    expect(after.ownership_version).toBe(afterClaim.ownership_version);
    // The message itself still counted.
    const [{ message_count }] = await AppDataSource.query(
      `SELECT message_count FROM chat_sessions WHERE id = $1`, [session.id],
    );
    expect(Number(message_count)).toBe(countBefore + 1);
  });

  it('B3: releaseAgentSessions moves ownership + bumps the version + re-queues the handoff atomically', async () => {
    const tenant = await makeTenantWithAi();
    const { user, agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'handoff', ownership: 'handoff_requested' });
    const handoff = await createTestHandoffRequest(session.id, tenant.id);

    await conversationCommands.claimConversation(session.id, agent.id, { mode: 'indefinite' });
    const before = await stateOf(session.id);
    expect(before).toMatchObject({ ownership: 'human_owned', status: 'handoff', assigned_agent_id: agent.id });

    await AppDataSource.transaction((manager) => releaseAgentSessions(user.id, tenant.id, manager));

    const after = await stateOf(session.id);
    expect(after).toMatchObject({
      ownership: 'handoff_requested', // pending-agent again, consistent with the re-queued handoff
      status: 'handoff',
      assigned_agent_id: null,
      human_control_mode: null,
      human_control_until: null,
    });
    // The version moved, so an in-flight AI run against the pre-release state is fenced.
    expect(after.ownership_version).toBe(before.ownership_version + 1);
    expect((await handoffRepo.findOneOrFail({ where: { id: handoff.id } })).status).toBe('requested');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Keep LAST in the file: down() temporarily drops the table the synchronized
// entity metadata expects; the final up() restores it (same pattern as the
// session-ownership-backfill migration test).

describe('CreateConversationCommands migration replay', () => {
  it('replays up(), down(), and up() cleanly against the synchronized schema', async () => {
    const migration = new CreateConversationCommands1791400000000();
    const queryRunner = AppDataSource.createQueryRunner();
    let needsRestore = false;
    try {
      await queryRunner.connect();
      await migration.up(queryRunner);
      await migration.up(queryRunner); // idempotent
      needsRestore = true;

      await migration.down(queryRunner);
      await migration.down(queryRunner); // idempotent
      const gone = await queryRunner.query(
        `SELECT to_regclass('public.conversation_commands') AS reg`,
      );
      expect(gone[0].reg).toBeNull();

      await migration.up(queryRunner);
      needsRestore = false;

      const cols = await queryRunner.query(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'conversation_commands'
          ORDER BY column_name`,
      );
      const byName = Object.fromEntries(
        (cols as Array<{ column_name: string; data_type: string; is_nullable: string }>).map((c) => [c.column_name, c]),
      );
      expect(byName.session_id).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' });
      expect(byName.tenant_id).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' });
      expect(byName.command).toMatchObject({ data_type: 'character varying', is_nullable: 'NO' });
      expect(byName.idempotency_key).toMatchObject({ data_type: 'character varying', is_nullable: 'NO' });
      expect(byName.result).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' });

      const [uq] = await queryRunner.query(
        `SELECT indexname FROM pg_indexes
          WHERE tablename = 'conversation_commands'
            AND indexname = 'uq_conversation_commands_session_command_key'`,
      );
      expect(uq?.indexname).toBe('uq_conversation_commands_session_command_key');

      const [fk] = await queryRunner.query(
        `SELECT confdeltype FROM pg_constraint
          WHERE conname = 'fk_conversation_commands_session'`,
      );
      expect(fk?.confdeltype).toBe('c'); // ON DELETE CASCADE
    } finally {
      if (needsRestore) await migration.up(queryRunner);
      await queryRunner.release();
    }
  });
});
