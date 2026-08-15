/**
 * B-PR3a — normalized realtime event contract (pilot-operations capability B4).
 *
 * Every convergence point must, AFTER its DB transaction commits, emit
 *   conversation:upsert { conversation, revision }
 *   message:created     { sessionId, message, conversationRevision }
 * to BOTH the tenant agents room and the per-session room, with the SAME
 * payload, WITHOUT regressing any legacy emit (message:new / message:receive /
 * handoff:* / session:closed). The conversation payload is produced by the
 * SAME serializer the REST `GET /chat/sessions` row uses, so the two shapes
 * cannot drift — and one test here guards exactly that.
 *
 * Real DB; mocked external boundaries (sockets, outbound router, localization,
 * agent service) — the same seams the conversation-commands suite mocks.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

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

// Channel entitlement is billing surface, not what this suite tests.
vi.mock('../../channels/channel-entitlement', () => ({
  isChannelEntitled: vi.fn(async () => true),
}));

// Fire-and-forget fan-out that the inbound pipeline triggers on new contacts.
vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: vi.fn(),
  buildEventBase: () => ({ id: 'e', tenantId: 't', sessionId: 's', timestamp: 'now', session: {} }),
}));
vi.mock('../../services/notification.service', () => ({
  notificationService: { createForTenant: vi.fn().mockResolvedValue(undefined) },
}));

import request from 'supertest';
import crypto from 'crypto';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { BotSettings } from '../../database/entities/Bot';
import { emitToSession, emitToTenantAgents } from '../../websocket/socket.handler';
import { serializeConversationSummary } from '../../realtime/conversation-serializer';
import { ingestWidgetCustomerMessage } from '../../services/widget-ingest';
import { processInboundEvent } from '../../channels/inbound-pipeline';
import type { NormalizedEvent } from '../../channels/types';
import {
  runTurn,
  getNewestUnansweredUserMessage,
  initializeAgentService,
} from '../../services/message-forwarding.service';
import type { AgentService } from '../../agent/agent.service';
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

const sessionRepo = AppDataSource.getRepository(ChatSession);

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

async function makeTenantWithAi() {
  const tenant = await createTestTenant({ settings: { ai: { apiKey: 'sk-test' } } as never });
  await createTestAnchorBot(tenant, { settings: { ai: AI } as BotSettings });
  return tenant;
}

async function makeOperator(tenantId: string) {
  const user = await createTestUser(tenantId, { role: 'admin' });
  const agent = await createTestAgent(tenantId, user.id);
  return { user, agent };
}

// ── Emit-capture helpers ─────────────────────────────────────────────────────

type AgentsCall = [string, string, Record<string, unknown>];
type SessionCall = [string, string, string, Record<string, unknown>];

const agentsCalls = (event: string): AgentsCall[] =>
  (emitToTenantAgents as unknown as Mock).mock.calls.filter((c) => c[1] === event) as AgentsCall[];
const sessionCalls = (event: string): SessionCall[] =>
  (emitToSession as unknown as Mock).mock.calls.filter((c) => c[2] === event) as SessionCall[];

/** The LAST conversation:upsert that reached the agents room for a session. */
function lastUpsertFor(sessionId: string) {
  const calls = agentsCalls('conversation:upsert').filter(
    (c) => (c[2] as { conversation: { id: string } }).conversation.id === sessionId,
  );
  return calls.length
    ? (calls[calls.length - 1][2] as { conversation: Record<string, unknown>; revision: number })
    : null;
}

function messageCreatedFor(sessionId: string) {
  return agentsCalls('message:created')
    .filter((c) => (c[2] as { sessionId: string }).sessionId === sessionId)
    .map((c) => c[2] as { sessionId: string; message: Record<string, unknown>; conversationRevision: number });
}

async function countTextMessages(sessionId: string): Promise<number> {
  const [{ count }] = (await AppDataSource.query(
    `SELECT COUNT(*)::int AS count FROM messages WHERE session_id = $1 AND type = 'text'`,
    [sessionId],
  )) as Array<{ count: number }>;
  return count;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRouteOutboundMessage.mockReset().mockResolvedValue({ success: true });
});

afterEach(() => {
  initializeAgentService(null as unknown as AgentService);
});

// ═════════════════════════════════════════════════════════════════════════════

describe('customer message paths — write once, emit both events to the agents room', () => {
  it('widget-REST ingest (ingestWidgetCustomerMessage) — the closed agents-room gap', async () => {
    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });

    await ingestWidgetCustomerMessage(session, 'hello from the widget');

    // Written exactly once.
    expect(await countTextMessages(session.id)).toBe(1);

    // message:created reached the agents room (this path NEVER did before).
    const created = messageCreatedFor(session.id);
    expect(created).toHaveLength(1);
    expect(created[0].message).toMatchObject({
      content: 'hello from the widget',
      senderType: 'user',
      sender: 'user',
      type: 'text',
      sessionId: session.id,
    });
    expect(typeof created[0].conversationRevision).toBe('number');

    // conversation:upsert too, carrying the fresh preview.
    const upsert = lastUpsertFor(session.id);
    expect(upsert).not.toBeNull();
    expect(upsert!.conversation).toMatchObject({
      id: session.id,
      lastMessage: 'hello from the widget',
      lastMessageSender: 'user',
      ownership: 'bot_owned',
      tenantId: tenant.id,
    });
    // Relation-only field OMITTED on the message hot path (assignedAgent not
    // loaded): a partial summary must never clobber a known name with null.
    expect('assignedAgentName' in upsert!.conversation).toBe(false);

    // SAME payloads to the per-session room (no per-room wrapping).
    const sessCreated = sessionCalls('message:created').filter((c) => c[1] === session.id);
    expect(sessCreated).toHaveLength(1);
    expect(sessCreated[0][3]).toEqual(created[0]);
    const sessUpsert = sessionCalls('conversation:upsert').filter((c) => c[1] === session.id);
    expect(sessUpsert).toHaveLength(1);
    expect(sessUpsert[0][3]).toEqual(upsert);

    // Backward compat: the legacy message:receive still fires, unchanged.
    const legacy = sessionCalls('message:receive').filter((c) => c[1] === session.id);
    expect(legacy).toHaveLength(1);
    expect(legacy[0][3]).toMatchObject({ content: 'hello from the widget' });
  });

  it('channel inbound (processInboundEvent) — session create + message, both announced', async () => {
    const tenant = await makeTenantWithAi();
    const connRepo = AppDataSource.getRepository(ChannelConnection);
    const connection = await connRepo.save(
      connRepo.create({
        tenantId: tenant.id,
        channel: 'messenger',
        status: 'active',
        platformAccountId: `page_${Date.now()}`,
      }),
    );
    const userId = `psid_${crypto.randomBytes(4).toString('hex')}`;
    const event: NormalizedEvent = {
      type: 'message',
      message: { type: 'text', content: 'hi from messenger' },
      sender: { externalUserId: userId, externalThreadId: userId, displayName: 'Chan User' },
      dedupeKey: `test:rt:${userId}:${Date.now()}`,
      timestamp: new Date(),
      rawEventType: 'message.text',
    };

    await processInboundEvent(event, connection);

    const [{ id: sessionId }] = (await AppDataSource.query(
      `SELECT id FROM chat_sessions WHERE tenant_id = $1 AND visitor_id = $2`,
      [tenant.id, userId],
    )) as Array<{ id: string }>;

    // Written exactly once.
    expect(await countTextMessages(sessionId)).toBe(1);

    // Session create emitted an upsert (new row), the message another — 2 total.
    const upserts = agentsCalls('conversation:upsert').filter(
      (c) => (c[2] as { conversation: { id: string } }).conversation.id === sessionId,
    );
    expect(upserts).toHaveLength(2);
    // The message upsert carries the preview; the create upsert carried none.
    expect((upserts[0][2] as { conversation: { lastMessage: string | null } }).conversation.lastMessage).toBeNull();
    expect((upserts[1][2] as { conversation: { lastMessage: string | null } }).conversation.lastMessage).toBe(
      'hi from messenger',
    );
    // One emit-time clock for every event type: the create-upsert can never
    // outrank the message-upsert that follows it (revision-ordering clients
    // apply with strict <, so equal same-ms revisions are applied, not dropped).
    const createRevision = (upserts[0][2] as { revision: number }).revision;
    const messageRevision = (upserts[1][2] as { revision: number }).revision;
    expect(messageRevision).toBeGreaterThanOrEqual(createRevision);
    const createdPayloads = messageCreatedFor(sessionId);
    expect(createdPayloads[0].conversationRevision).toBeGreaterThanOrEqual(createRevision);

    const created = messageCreatedFor(sessionId);
    expect(created).toHaveLength(1);
    expect(created[0].message).toMatchObject({ content: 'hi from messenger', senderType: 'user' });

    // Backward compat: the legacy message:new still reaches the agents room.
    const legacyNew = agentsCalls('message:new').filter(
      (c) => (c[2] as { sessionId: string }).sessionId === sessionId,
    );
    expect(legacyNew).toHaveLength(1);
  });

  it('socket customer message (handleMessageSend) — real handler, events reach the agents room', async () => {
    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const participant = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });

    // The REAL handler (module under test), while its fan-out still resolves to
    // this suite's socket.handler mock through the realtime module.
    const actual = await vi.importActual<typeof import('../../websocket/socket.handler')>(
      '../../websocket/socket.handler',
    );
    const fakeSocket = {
      data: {
        user: { id: participant.id, email: '', role: 'agent', tenantId: tenant.id, type: 'widget' },
        tenantId: tenant.id,
        participantId: participant.id,
        boundSessionId: session.id,
      },
      emit: vi.fn(),
    };

    await actual.handleMessageSend(fakeSocket as never, {
      sessionId: session.id,
      content: 'over the socket',
    });

    expect(fakeSocket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    expect(await countTextMessages(session.id)).toBe(1);

    const created = messageCreatedFor(session.id);
    expect(created).toHaveLength(1);
    expect(created[0].message).toMatchObject({ content: 'over the socket', senderType: 'user' });
    expect(lastUpsertFor(session.id)!.conversation).toMatchObject({
      id: session.id,
      lastMessage: 'over the socket',
      lastMessageSender: 'user',
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('bot reply — the closed agents-room gap', () => {
  it('runTurn commits the reply and emits message:created + conversation:upsert (senderType bot)', async () => {
    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    const msg = await createTestMessage(session.id, tenant.id, user.id, { content: 'help me book' });

    initializeAgentService({
      run: vi.fn().mockResolvedValue({ type: 'response', content: 'Sure, when suits you?' }),
    } as unknown as AgentService);

    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    const pending = await getNewestUnansweredUserMessage(fresh);
    expect(pending?.id).toBe(msg.id);
    expect(await runTurn(fresh, pending!)).toBe('answered');

    const created = messageCreatedFor(session.id);
    expect(created).toHaveLength(1);
    expect(created[0].message).toMatchObject({
      content: 'Sure, when suits you?',
      senderType: 'bot',
      sender: 'bot',
    });

    const upsert = lastUpsertFor(session.id);
    expect(upsert!.conversation).toMatchObject({
      id: session.id,
      lastMessage: 'Sure, when suits you?',
      lastMessageSender: 'bot',
    });

    // Backward compat: the reply still goes through the outbound router with
    // its legacy message:receive socketEvent.
    expect(mockRouteOutboundMessage).toHaveBeenCalledTimes(1);
    const [, , socketEvent] = mockRouteOutboundMessage.mock.calls[0] as [unknown, unknown, { event: string }];
    expect(socketEvent.event).toBe('message:receive');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('operator REST reply — POST /chats/:sessionId/messages', () => {
  it('emits both events (senderType agent) and the upsert carries the auto-claimed ownership', async () => {
    const tenant = await makeTenantWithAi();
    const { user, agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/chats/${session.id}/messages`)
      .send({ clientMessageId: 'rt-m1', content: 'Operator here' });
    expect(res.status).toBe(201);

    const created = messageCreatedFor(session.id);
    expect(created).toHaveLength(1);
    expect(created[0].message).toMatchObject({
      id: res.body.data.message.id,
      content: 'Operator here',
      senderType: 'agent',
    });

    const upsert = lastUpsertFor(session.id);
    expect(upsert!.conversation).toMatchObject({
      id: session.id,
      ownership: 'human_owned',
      assignedAgentId: agent.id,
      assignedAgent: { id: agent.id },
      lastMessage: 'Operator here',
      lastMessageSender: 'agent',
    });
    // Ownership-path upserts re-select WITH the relation, so the relation-only
    // field is PRESENT here (contrast: message hot paths omit it).
    expect('assignedAgentName' in upsert!.conversation).toBe(true);
    expect(upsert!.conversation.assignedAgentName).toBe(user.id);

    // Backward compat: legacy message:new + handoff:assigned still fire.
    expect(agentsCalls('message:new')).toHaveLength(1);
    expect(agentsCalls('handoff:assigned')).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('session create → conversation:upsert (new row) to the agents room', () => {
  it('POST /auth/widget announces the created conversation', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant);

    const res = await request(app).post('/api/v1/auth/widget').send({ apiKey: tenant.apiKey });
    expect(res.status).toBe(200);
    const sessionId = res.body.data.session.id as string;

    const upsert = lastUpsertFor(sessionId);
    expect(upsert).not.toBeNull();
    expect(upsert!.conversation).toMatchObject({
      id: sessionId,
      sessionId,
      tenantId: tenant.id,
      ownership: 'bot_owned',
      messageCount: 0,
      lastMessage: null,
    });
    expect(typeof upsert!.revision).toBe('number');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('ownership/lifecycle commands → conversation:upsert with the NEW ownership', () => {
  it('takeover / release / close each announce the committed state (release+close closed gaps)', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    // Takeover → human_owned.
    const takeover = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ idempotencyKey: 'rt-tk-1', mode: 'indefinite' });
    expect(takeover.status).toBe(200);
    expect(lastUpsertFor(session.id)!.conversation).toMatchObject({
      ownership: 'human_owned',
      status: 'handoff',
      assignedAgentId: agent.id,
    });
    expect(agentsCalls('handoff:assigned')).toHaveLength(1); // legacy intact

    // Release → bot_owned (previously session-room only).
    vi.clearAllMocks();
    const release = await request(app)
      .post(`/api/v1/chats/${session.id}/release`)
      .send({ idempotencyKey: 'rt-rel-1' });
    expect(release.status).toBe(200);
    expect(lastUpsertFor(session.id)!.conversation).toMatchObject({
      ownership: 'bot_owned',
      status: 'bot',
      assignedAgentId: null,
      assignedAgent: null,
    });
    expect(sessionCalls('handoff:returned')).toHaveLength(1); // legacy intact

    // Close → closed (previously session-room only).
    vi.clearAllMocks();
    const close = await request(app)
      .post(`/api/v1/chats/${session.id}/close`)
      .send({ idempotencyKey: 'rt-close-1' });
    expect(close.status).toBe(200);
    expect(lastUpsertFor(session.id)!.conversation).toMatchObject({
      ownership: 'closed',
      status: 'closed',
    });
    expect(sessionCalls('session:closed')).toHaveLength(1); // legacy intact
  });

  it('cancel announces the return to bot_owned', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'handoff', ownership: 'handoff_requested' });
    await createTestHandoffRequest(session.id, tenant.id);
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    const cancel = await request(app)
      .post(`/api/v1/chats/${session.id}/cancel`)
      .send({ idempotencyKey: 'rt-cx-1' });
    expect(cancel.status).toBe(200);
    expect(lastUpsertFor(session.id)!.conversation).toMatchObject({
      ownership: 'bot_owned',
      status: 'bot',
      assignedAgentId: null,
    });
    expect(agentsCalls('handoff:rejected')).toHaveLength(1); // legacy intact
  });

  it('an idempotent REPLAY does not re-emit', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ idempotencyKey: 'rt-tk-replay', mode: 'indefinite' });
    vi.clearAllMocks();
    const retry = await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ idempotencyKey: 'rt-tk-replay', mode: 'indefinite' });
    expect(retry.status).toBe(200);
    expect(agentsCalls('conversation:upsert')).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('shape drift guard — serializer IS the REST list row', () => {
  it('the socket conversation payload and the GET /chats/sessions row have identical keys', async () => {
    const tenant = await makeTenantWithAi();
    const { agent } = await makeOperator(tenant.id);
    const session = await createTestSession(tenant.id, { status: 'bot' });
    configureMockAuth(auth, { userId: agent.id, tenantId: tenant.id, role: 'admin' });

    // Produce a socket payload (takeover) …
    await request(app)
      .post(`/api/v1/chats/${session.id}/takeover`)
      .send({ idempotencyKey: 'rt-shape-1', mode: 'indefinite' });
    const socketConversation = lastUpsertFor(session.id)!.conversation;

    // … and fetch the REST row for the same session.
    const list = await request(app).get('/api/v1/chats/sessions?limit=100');
    expect(list.status).toBe(200);
    const row = list.body.data.find((r: { id: string }) => r.id === session.id);
    expect(row).toBeDefined();

    expect(Object.keys(socketConversation).sort()).toEqual(Object.keys(row).sort());

    // And both match the serializer applied directly to the entity.
    const entity = await sessionRepo.findOneOrFail({
      where: { id: session.id },
      relations: ['assignedAgent'],
    });
    const direct = serializeConversationSummary(entity, { lastMessage: null });
    expect(Object.keys(direct).sort()).toEqual(Object.keys(row).sort());

    // Values agree on the load-bearing columns.
    expect(row).toMatchObject({
      id: session.id,
      sessionId: session.id,
      ownership: 'human_owned',
      ownershipVersion: 1,
      assignedAgentId: agent.id,
      tenantId: tenant.id,
      channel: 'widget',
    });
  });
});
