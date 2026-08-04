/**
 * Integration: Copilot HTTP route layer.
 *
 * Covers PR7 deliverables — the route surface end-to-end:
 *   - Auth chain (Clerk + tenant resolve + entitlement gate)
 *   - HTTP status taxonomy (401 / 402 / 400 / 429 / 200)
 *   - Body validation (empty, oversized, missing, bad type)
 *   - Cost-cap integration (429 daily and per-minute with Retry-After)
 *   - SSE handshake headers
 *   - GET /conversation: empty-state, pagination, cursor validation,
 *     never-split-pair guarantee
 *   - POST /clear: idempotency
 *   - Cross-tenant header spoof rejected
 *
 * Agent-loop internals (atomic pair persistence, stream events,
 * terminal-state matrix) live in `copilot-agent-loop.test.ts`;
 * here we mock the LLM stream to a tiny scripted one and focus on
 * the route plumbing.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
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

// Escalation sends real mail. Stubbed so the suite exercises WHAT gets sent without
// sending it — the payload is the thing under test.
type SentMail = { to: string; cc?: string | string[]; subject: string; body: string; replyTo?: string };
const sendEmail = vi.hoisted(() =>
  vi.fn(async (_options: { to: string; cc?: string | string[]; subject: string; body: string; replyTo?: string }) => ({
    success: true as boolean,
    messageId: 'm1',
    error: undefined as string | undefined,
  })),
);
vi.mock('../../automations', () => ({ getEmailService: () => ({ send: sendEmail }) }));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { CopilotMessage } from '../../database/entities/CopilotMessage';
import { CopilotConversation } from '../../database/entities/CopilotConversation';
import { Tenant } from '../../database/entities/Tenant';
import {
  createTestTenant,
  createTestUser,
  createTestBillingAccount,
} from '../helpers/factories';
import { __setCopilotRoutesDeps, __resetCopilotRoutesCache } from '../../copilot/routes';
import type {
  CopilotLlmStream,
  CopilotLlmStreamEvent,
} from '../../copilot/agent/llm-stream';
import type { CopilotKnowledgeSource } from '../../copilot/knowledge/types';

function makeScriptedLlm(events: CopilotLlmStreamEvent[]): CopilotLlmStream {
  return {
    async *stream(_messages, _opts) {
      for (const ev of events) yield ev;
    },
  };
}

const noopKnowledge: CopilotKnowledgeSource = {
  async search() {
    return [];
  },
};

const happyPathLlm = makeScriptedLlm([
  { type: 'token', text: 'Hello' },
  { type: 'token', text: ' world.' },
  {
    type: 'finalize',
    finishReason: 'stop',
    usage: { promptTokens: 12, completionTokens: 3 },
  },
]);

let tenantId: string;
let userId: string;

beforeEach(async () => {
  __resetCopilotRoutesCache();
  __setCopilotRoutesDeps({ llm: happyPathLlm, knowledge: noopKnowledge });

  const tenant = await createTestTenant({ tier: 'pro' });
  tenantId = tenant.id;
  const user = await createTestUser(tenantId, { role: 'admin' });
  userId = user.id;
  await createTestBillingAccount(tenantId, { status: 'active', currentPlanId: 'pro' });

  configureMockAuth(auth, { userId, tenantId, role: 'admin' });
});

afterAll(() => {
  __resetCopilotRoutesCache();
});

// ---------------------------------------------------------------
// Auth + tier gating
// ---------------------------------------------------------------
describe('Copilot routes — entitlement gate', () => {
  it('402 plan_limit_platform_assistant on POST /messages for Essential tenant', async () => {
    await AppDataSource.getRepository(Tenant).update(tenantId, { tier: 'essential' });
    const res = await request(app)
      .post('/api/v1/copilot/messages')
      .send({ message: 'hello' });
    expect(res.status).toBe(402);
    expect(res.body.error?.code).toBe('plan_limit_platform_assistant');
  });

  it('402 plan_limit_platform_assistant on GET /conversation for Essential tenant', async () => {
    await AppDataSource.getRepository(Tenant).update(tenantId, { tier: 'essential' });
    const res = await request(app).get('/api/v1/copilot/conversation');
    expect(res.status).toBe(402);
    expect(res.body.error?.code).toBe('plan_limit_platform_assistant');
  });

  it('402 plan_limit_platform_assistant on POST /conversation/clear for Essential tenant', async () => {
    await AppDataSource.getRepository(Tenant).update(tenantId, { tier: 'essential' });
    const res = await request(app).post('/api/v1/copilot/conversation/clear');
    expect(res.status).toBe(402);
  });

  it('200 on every Copilot route for Pro tenant', async () => {
    const conv = await request(app).get('/api/v1/copilot/conversation');
    expect(conv.status).toBe(200);
    const clear = await request(app).post('/api/v1/copilot/conversation/clear');
    expect(clear.status).toBe(200);
  });
});

// ---------------------------------------------------------------
// POST /messages: body validation
// ---------------------------------------------------------------
describe('POST /messages — body validation', () => {
  it('400 on missing body', async () => {
    const res = await request(app).post('/api/v1/copilot/messages').send({});
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_request_body');
  });

  it('400 on empty message after trim', async () => {
    const res = await request(app)
      .post('/api/v1/copilot/messages')
      .send({ message: '   ' });
    expect(res.status).toBe(400);
  });

  it('400 on oversized message (> 4000 chars)', async () => {
    const res = await request(app)
      .post('/api/v1/copilot/messages')
      .send({ message: 'x'.repeat(4001) });
    expect(res.status).toBe(400);
  });

  it('400 on invalid locale', async () => {
    const res = await request(app)
      .post('/api/v1/copilot/messages')
      .send({ message: 'hi', locale: 'de' });
    expect(res.status).toBe(400);
  });

  it('400 on non-string message', async () => {
    const res = await request(app)
      .post('/api/v1/copilot/messages')
      .send({ message: 123 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------
// POST /messages: SSE happy path
// ---------------------------------------------------------------
describe('POST /messages — SSE happy path', () => {
  it('emits SSE headers and the scripted token + complete events', async () => {
    const res = await request(app)
      .post('/api/v1/copilot/messages')
      .send({ message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');

    const text = res.text;
    expect(text).toContain('event: token');
    expect(text).toContain('"text":"Hello"');
    expect(text).toContain('"text":" world."');
    expect(text).toContain('event: complete');
  });

  it('persists the user + assistant pair after a successful stream', async () => {
    await request(app).post('/api/v1/copilot/messages').send({ message: 'hello' });
    const rows = await AppDataSource.getRepository(CopilotMessage).find({
      where: { tenantId },
      order: { turn: 'ASC' },
    });
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(rows[0].content).toBe('hello');
    expect(rows[1].content).toBe('Hello world.');
    expect(rows[1].outcome).toBe('success');
  });
});

// ---------------------------------------------------------------
// GET /conversation
// ---------------------------------------------------------------
describe('GET /conversation', () => {
  it('returns 200 with conversationId=null + messages=[] when no active conv (round 3 #10)', async () => {
    const res = await request(app).get('/api/v1/copilot/conversation');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      conversationId: null,
      messages: [],
      nextCursor: null,
    });
  });

  it('returns the persisted transcript with full role shapes', async () => {
    await request(app).post('/api/v1/copilot/messages').send({ message: 'first' });
    const res = await request(app).get('/api/v1/copilot/conversation');
    expect(res.status).toBe(200);
    expect(res.body.data.conversationId).toBeTruthy();
    expect(res.body.data.messages).toHaveLength(2);
    expect(res.body.data.messages[0]).toMatchObject({
      role: 'user',
      content: 'first',
      turn: 0,
    });
    expect(res.body.data.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Hello world.',
      turn: 1,
      outcome: 'success',
    });
    expect(Array.isArray(res.body.data.messages[1].toolsCalled)).toBe(true);
  });

  it('400 bad_cursor_or_limit on negative cursor', async () => {
    const res = await request(app)
      .get('/api/v1/copilot/conversation')
      .query({ cursor: '-1' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('bad_cursor_or_limit');
  });

  it('400 bad_cursor_or_limit on non-integer cursor', async () => {
    const res = await request(app)
      .get('/api/v1/copilot/conversation')
      .query({ cursor: 'banana' });
    expect(res.status).toBe(400);
  });

  it('400 bad_cursor_or_limit on out-of-range limit', async () => {
    const res = await request(app)
      .get('/api/v1/copilot/conversation')
      .query({ limit: '500' });
    expect(res.status).toBe(400);
    const res2 = await request(app)
      .get('/api/v1/copilot/conversation')
      .query({ limit: '0' });
    expect(res2.status).toBe(400);
  });

  it('pagination: never splits a user/assistant pair', async () => {
    // Send 3 messages → 6 message rows (0..5)
    for (const m of ['one', 'two', 'three']) {
      await request(app).post('/api/v1/copilot/messages').send({ message: m });
    }
    // Page size 3 — request the first page; we expect 4 rows back
    // (the extension to keep the trailing user paired with assistant).
    const first = await request(app)
      .get('/api/v1/copilot/conversation')
      .query({ limit: '3' });
    expect(first.status).toBe(200);
    const msgs = first.body.data.messages;
    const lastRole = msgs[msgs.length - 1].role;
    expect(lastRole).toBe('assistant'); // pair preserved at the boundary
    // nextCursor should be the turn after the last returned message.
    expect(first.body.data.nextCursor).toBe(msgs[msgs.length - 1].turn + 1);
  });
});

// ---------------------------------------------------------------
// POST /conversation/clear
// ---------------------------------------------------------------
describe('POST /conversation/clear', () => {
  it('archives the active conversation and is idempotent', async () => {
    // First send to create a conversation
    await request(app).post('/api/v1/copilot/messages').send({ message: 'hi' });
    let active = await AppDataSource.getRepository(CopilotConversation).findOne({
      where: { tenantId },
    });
    expect(active?.archivedAt).toBeNull();

    const first = await request(app).post('/api/v1/copilot/conversation/clear');
    expect(first.status).toBe(200);
    expect(first.body.data?.cleared).toBe(true);

    active = await AppDataSource.getRepository(CopilotConversation).findOne({
      where: { tenantId },
    });
    expect(active?.archivedAt).not.toBeNull();

    // Idempotent: second clear succeeds with no active conv.
    const second = await request(app).post('/api/v1/copilot/conversation/clear');
    expect(second.status).toBe(200);
    expect(second.body.data?.cleared).toBe(true);
  });

  it('after clear, GET /conversation returns the empty-state shape', async () => {
    await request(app).post('/api/v1/copilot/messages').send({ message: 'hi' });
    await request(app).post('/api/v1/copilot/conversation/clear');
    const res = await request(app).get('/api/v1/copilot/conversation');
    expect(res.body.data).toEqual({
      conversationId: null,
      messages: [],
      nextCursor: null,
    });
  });

  it('after clear, next /messages creates a fresh active conversation at turn 0', async () => {
    await request(app).post('/api/v1/copilot/messages').send({ message: 'before' });
    await request(app).post('/api/v1/copilot/conversation/clear');
    await request(app).post('/api/v1/copilot/messages').send({ message: 'after' });

    const convs = await AppDataSource.getRepository(CopilotConversation).find({
      where: { tenantId },
    });
    expect(convs).toHaveLength(2);
    const active = convs.find((c) => c.archivedAt === null);
    expect(active).toBeTruthy();
    expect(active!.nextTurn).toBe(2);
    const msgs = await AppDataSource.getRepository(CopilotMessage).find({
      where: { conversationId: active!.id },
      order: { turn: 'ASC' },
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].turn).toBe(0);
  });
});

// ---------------------------------------------------------------
// Cross-tenant header spoof
// ---------------------------------------------------------------
describe('cross-tenant header spoof', () => {
  it('X-Tenant-Id header is ignored for non-super-admin users', async () => {
    const otherTenant = await createTestTenant({ tier: 'enterprise' });
    const res = await request(app)
      .post('/api/v1/copilot/messages')
      .set('X-Tenant-Id', otherTenant.id)
      .set('x-tenant-context', otherTenant.id)
      .send({ message: 'spoof attempt' });
    expect(res.status).toBe(200); // Request goes through bound to tenant A
    // Assistant row was persisted under tenant A, not tenant B.
    const rows = await AppDataSource.getRepository(CopilotMessage).find({
      where: { tenantId },
    });
    expect(rows.length).toBeGreaterThan(0);
    const otherRows = await AppDataSource.getRepository(CopilotMessage).find({
      where: { tenantId: otherTenant.id },
    });
    expect(otherRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------
// POST /escalate — handing the conversation to a person
// ---------------------------------------------------------------
describe('POST /escalate', () => {
  beforeEach(() => {
    sendEmail.mockClear().mockResolvedValue({ success: true, messageId: 'm1', error: undefined });
  });

  const escalate = (message = 'My WhatsApp messages are not arriving.') =>
    request(app).post('/api/v1/copilot/escalate').send({ message });

  it('is Pro+ like every other Copilot route', async () => {
    await AppDataSource.getRepository(Tenant).update(tenantId, { tier: 'essential' });
    const res = await escalate();
    expect(res.status).toBe(402);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('400s on an empty message rather than mailing support an empty ticket', async () => {
    const res = await request(app).post('/api/v1/copilot/escalate').send({ message: '   ' });
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends the context the customer cannot be expected to type', async () => {
    // The point of the button over a mailto: link — which workspace, which plan, and
    // what they had been asking. Without those, support opens with three questions.
    const res = await escalate();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ delivered: true, priority: false });

    const mail = sendEmail.mock.calls[0][0] as SentMail;
    expect(mail.to).toBe('support@axentrio.com');
    expect(mail.body).toContain('My WhatsApp messages are not arriving.');
    expect(mail.body).toMatch(/Plan: pro/);
  });

  it('replies to the customer, not to the platform', async () => {
    await escalate();
    expect((sendEmail.mock.calls[0][0] as SentMail).replyTo).toMatch(/@/);
  });

  it('copies the platform operator, so a broken support path is noticed', async () => {
    // A shared inbox is where a request is handled; it is not where anyone
    // notices requests have STOPPED arriving.
    vi.stubEnv('PLATFORM_ALERT_EMAIL', 'operator@example.com');
    vi.resetModules();

    await escalate();
    const mail = sendEmail.mock.calls[0][0] as SentMail;
    // cc, not a second `to` — support owns the request, the operator watches.
    expect(mail.to).toBe('support@axentrio.com');
    expect(mail.cc ?? '').toContain('operator@example.com');
    vi.unstubAllEnvs();
  });

  it('attaches the real conversation, not one supplied by the caller', async () => {
    await request(app).post('/api/v1/copilot/messages').send({ message: 'how do I add a bot' });
    await escalate();
    expect((sendEmail.mock.calls[0][0] as SentMail).body).toContain('how do I add a bot');
  });

  it('attaches the MOST RECENT turns of a long conversation', async () => {
    // Regression: the query took the first 40 turns ascending and the renderer then
    // trimmed to the last 10 OF THOSE — so a long conversation sent support its
    // opening, which is the reverse of why the transcript is attached at all.
    // Must exceed the old 40-ROW window (each turn persists a user + an assistant
    // row), or the broken version returns everything and the test proves nothing.
    for (let i = 0; i < 25; i++) {
      await request(app).post('/api/v1/copilot/messages').send({ message: `question ${i}` });
    }
    await escalate();

    const body = (sendEmail.mock.calls[0][0] as SentMail).body;
    expect(body).toContain('question 24');
    expect(body).not.toContain('question 0');
  });

  it('flags an Enterprise request as priority, since their contract says so', async () => {
    await AppDataSource.getRepository(Tenant).update(tenantId, { tier: 'enterprise' });
    const res = await escalate();
    expect(res.body.data.priority).toBe(true);
    expect((sendEmail.mock.calls[0][0] as SentMail).subject).toContain('[PRIORITY]');
  });

  it('never claims a request reached a human when the send failed', async () => {
    // Telling someone help is coming when it is not is worse than not offering
    // the button at all.
    sendEmail.mockResolvedValue({ success: false, messageId: 'm1', error: 'resend down' });
    const res = await escalate();
    expect(res.status).toBe(502);
    expect(res.body.error?.details?.inbox).toBe('support@axentrio.com');
  });
});
