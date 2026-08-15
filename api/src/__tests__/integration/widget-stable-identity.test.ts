/**
 * Stable widget customer identity (B-PR4a): one (tenant, bot, visitor) =
 * at most ONE non-closed widget session.
 *
 * The seams under test:
 *  - /widget/init resolves across ALL non-closed states (bot/waiting/handoff/
 *    active) - the old status='active' filter is why dedup was dead: an
 *    AI-enabled bot's sessions live in 'bot' and never resolved.
 *  - The resolve-or-create runs under a pg advisory xact lock on the identity,
 *    so a two-tab race yields exactly one session (the loser resolves the
 *    winner - never a unique-index 500).
 *  - The partial unique index uq_chat_sessions_widget_open exists in the
 *    (synchronize-built) schema and rejects a second open widget session.
 *  - /widget/new-conversation atomically closes the current session (through
 *    the command service: ownership='closed' + the system event) and opens a
 *    new one for the SAME visitorId.
 *  - Old cached widgets that still mint a random visitorId per load keep
 *    working: random ids never collide in the partial index, so they simply
 *    create (allowed) - rollout is safe while embeds refresh their cache.
 */
import { describe, it, expect, vi } from 'vitest';
import { createAuthMocks } from '../helpers/auth';

createAuthMocks();
vi.mock('@clerk/express', () => ({ clerkMiddleware: () => (_r: any, _s: any, n: any) => n() }));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
  emitToRoom: vi.fn(),
}));
// S1 partial-success seam: a switchable one-shot failure in the greeting's
// config resolution, passthrough otherwise. Lets a test prove that a
// post-commit greeting failure never 500s and that a resolve-retry heals it.
const resolverState = vi.hoisted(() => ({ failNext: false }));
vi.mock('../../templates/template-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../templates/template-resolver')>();
  return {
    ...actual,
    effectiveBotConfig: vi.fn(async (...args: Parameters<typeof actual.effectiveBotConfig>) => {
      if (resolverState.failNext) {
        resolverState.failNext = false;
        throw new Error('greeting backend down (test)');
      }
      return actual.effectiveBotConfig(...args);
    }),
  };
});

import crypto from 'crypto';
import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { Participant } from '../../database/entities/Participant';
import { createTestTenant, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';
import type { Bot } from '../../database/entities/Bot';

/** AI-enabled anchor bot ⇒ new sessions start in status 'bot' - the exact
 *  state the old resolve filter missed. */
async function makeAiTenant(): Promise<{ tenant: Tenant; bot: Bot }> {
  const tenant = await createTestTenant({ tier: 'pro' });
  const bot = await createTestAnchorBot(tenant, {
    settings: { ai: { enabled: true } } as unknown as Bot['settings'],
  });
  return { tenant, bot };
}

const init = (apiKey: string, visitorId: string) =>
  request(app).post('/api/v1/widget/init').send({ apiKey, visitorId });

const newConversation = (token: string) =>
  request(app)
    .post('/api/v1/widget/new-conversation')
    .set('Authorization', `Bearer ${token}`)
    .send({});

async function openSessions(tenantId: string, visitorId: string): Promise<Array<{ id: string; status: string }>> {
  return AppDataSource.query(
    `SELECT id, status::text AS status FROM chat_sessions
      WHERE tenant_id = $1 AND visitor_id = $2 AND status <> 'closed' AND source = 'widget'`,
    [tenantId, visitorId],
  );
}

describe('stable widget identity - /widget/init resolve-or-create', () => {
  it('a returning visitor resolves the SAME bot-state session (isNew:false, fresh token, no new row)', async () => {
    const { tenant, bot } = await makeAiTenant();
    const visitorId = `stable-${crypto.randomBytes(4).toString('hex')}`;

    const first = await init(bot.publicKey, visitorId);
    expect(first.status).toBe(200);
    expect(first.body.data.isNew).toBe(true);
    expect(first.body.data.session.status).toBe('bot'); // AI-enabled ⇒ 'bot', not 'active'
    expect(first.body.data.session.tenantId).toBe(tenant.id);
    expect(first.body.data.customerThreadId).toBe(`w:${tenant.id}:${bot.id}:${visitorId}`);

    const second = await init(bot.publicKey, visitorId);
    expect(second.status).toBe(200);
    expect(second.body.data.isNew).toBe(false);
    expect(second.body.data.session.id).toBe(first.body.data.session.id);
    // A fresh, WORKING token is issued on resolve (reconnect/token-expiry recovery).
    expect(second.body.data.token).toBeTruthy();
    const hist = await request(app)
      .get('/api/v1/widget/history')
      .set('Authorization', `Bearer ${second.body.data.token}`);
    expect(hist.status).toBe(200);

    expect(await openSessions(tenant.id, visitorId)).toHaveLength(1);
  });

  it('resolves a session parked in handoff too - every non-closed state counts', async () => {
    const { tenant, bot } = await makeAiTenant();
    const visitorId = `handoff-${crypto.randomBytes(4).toString('hex')}`;

    const first = await init(bot.publicKey, visitorId);
    await AppDataSource.query(
      `UPDATE chat_sessions SET status = 'handoff', ownership = 'handoff_requested' WHERE id = $1`,
      [first.body.data.session.id],
    );

    const second = await init(bot.publicKey, visitorId);
    expect(second.body.data.isNew).toBe(false);
    expect(second.body.data.session.id).toBe(first.body.data.session.id);
    expect(await openSessions(tenant.id, visitorId)).toHaveLength(1);
  });

  it('two-tab cold start: concurrent inits converge on exactly ONE session', async () => {
    const { tenant, bot } = await makeAiTenant();
    const visitorId = `race-${crypto.randomBytes(4).toString('hex')}`;

    const [a, b] = await Promise.all([init(bot.publicKey, visitorId), init(bot.publicKey, visitorId)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.data.session.id).toBe(b.body.data.session.id);
    // Exactly one creator; the loser resolved the winner.
    expect([a.body.data.isNew, b.body.data.isNew].filter(Boolean)).toHaveLength(1);
    expect(await openSessions(tenant.id, visitorId)).toHaveLength(1);
  });

  it('OLD cached widgets (random visitorId per load) still work: distinct ids always create', async () => {
    const { tenant, bot } = await makeAiTenant();
    const a = await init(bot.publicKey, `widget-${crypto.randomBytes(5).toString('hex')}`);
    const b = await init(bot.publicKey, `widget-${crypto.randomBytes(5).toString('hex')}`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.data.isNew).toBe(true);
    expect(b.body.data.isNew).toBe(true);
    expect(a.body.data.session.id).not.toBe(b.body.data.session.id);
    void tenant;
  });

  it('rejects an oversized or control-character visitorId with a client error, never a DB 500', async () => {
    const { bot } = await makeAiTenant();
    expect((await init(bot.publicKey, 'x'.repeat(300))).status).toBe(422);
    // NUL breaks Postgres text outright; other control chars ride along (S3).
    expect((await init(bot.publicKey, 'bad\u0000visitor')).status).toBe(422);
    expect((await init(bot.publicKey, 'bad\nvisitor')).status).toBe(422);
  });
});

describe('S1 - session usable is all-or-nothing; greeting is idempotent + self-healing', () => {
  it('commits the visitor participant WITH the session', async () => {
    const { bot } = await makeAiTenant();
    const visitorId = `atomic-${crypto.randomBytes(4).toString('hex')}`;
    const res = await init(bot.publicKey, visitorId);
    const parts = await AppDataSource.getRepository(Participant).find({
      where: { sessionId: res.body.data.session.id },
    });
    expect(parts.some((p) => p.type === 'user')).toBe(true);
  });

  it('a greeting failure never 500s; the next resolve heals it exactly once', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const bot = await createTestAnchorBot(tenant, {
      settings: {
        ai: { enabled: true, guardrails: { greetingMessage: 'Hello from the test bot' } },
      } as unknown as Bot['settings'],
    });
    const visitorId = `heal-${crypto.randomBytes(4).toString('hex')}`;
    const messagesOf = (sessionId: string) =>
      AppDataSource.getRepository(Message).find({ where: { sessionId } });

    // The greeting's config resolution fails ONCE, post-commit.
    resolverState.failNext = true;
    const first = await init(bot.publicKey, visitorId);
    expect(first.status).toBe(200); // the session committed whole - no 500
    const sessionId = first.body.data.session.id as string;

    // Usable: participant present, token works - only the greeting is missing.
    const parts = await AppDataSource.getRepository(Participant).find({ where: { sessionId } });
    expect(parts.some((p) => p.type === 'user')).toBe(true);
    expect(await messagesOf(sessionId)).toHaveLength(0);

    // The resolve-retry heals the missing greeting...
    const second = await init(bot.publicKey, visitorId);
    expect(second.body.data.isNew).toBe(false);
    expect(second.body.data.session.id).toBe(sessionId);
    expect(await messagesOf(sessionId)).toHaveLength(1);

    // ...and a further resolve does NOT duplicate it (idempotent).
    await init(bot.publicKey, visitorId);
    expect(await messagesOf(sessionId)).toHaveLength(1);
  });
});

describe('POST /auth/widget - the guarded legacy creator (review fix B1)', () => {
  const authWidget = (body: Record<string, unknown>) =>
    request(app).post('/api/v1/auth/widget').send(body);

  it('two concurrent calls for one userId converge on exactly ONE session - no 500', async () => {
    const { tenant, bot } = await makeAiTenant();
    const userId = `auth-race-${crypto.randomBytes(4).toString('hex')}`;

    const [a, b] = await Promise.all([
      authWidget({ apiKey: bot.publicKey, userId }),
      authWidget({ apiKey: bot.publicKey, userId }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.data.session.id).toBe(b.body.data.session.id);
    expect(await openSessions(tenant.id, userId)).toHaveLength(1);
  });

  it('a returning userId resolves its open BOT-state session instead of duplicating', async () => {
    const { tenant, bot } = await makeAiTenant(); // AI on => sessions live in 'bot'
    const userId = `auth-return-${crypto.randomBytes(4).toString('hex')}`;

    const first = await authWidget({ apiKey: bot.publicKey, userId });
    const second = await authWidget({ apiKey: bot.publicKey, userId });
    expect(second.status).toBe(200);
    expect(second.body.data.session.id).toBe(first.body.data.session.id);
    expect(await openSessions(tenant.id, userId)).toHaveLength(1);
  });

  it('anonymous callers get a UNIQUE identity per call - never a shared session, never a 500', async () => {
    const { bot } = await makeAiTenant();
    const a = await authWidget({ apiKey: bot.publicKey });
    const b = await authWidget({ apiKey: bot.publicKey });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Sharing one 'anonymous' identity would hand visitor B visitor A's
    // transcript; distinct sessions preserve the legacy per-call behavior.
    expect(a.body.data.session.id).not.toBe(b.body.data.session.id);
  });

  it('resumes a provided sessionId in ANY non-closed state (the active-only filter is dead)', async () => {
    const { tenant, bot } = await makeAiTenant();
    const userId = `auth-resume-${crypto.randomBytes(4).toString('hex')}`;
    const first = await authWidget({ apiKey: bot.publicKey, userId });
    const sessionId = first.body.data.session.id as string;
    expect(first.body.data.session.status).toBe('bot'); // NOT 'active'

    const again = await authWidget({ apiKey: bot.publicKey, sessionId, userId });
    expect(again.status).toBe(200);
    expect(again.body.data.session.id).toBe(sessionId);
    expect(await openSessions(tenant.id, userId)).toHaveLength(1);
  });

  it('rejects a control-character userId with a client error (S3)', async () => {
    const { bot } = await makeAiTenant();
    const res = await authWidget({ apiKey: bot.publicKey, userId: 'bad\u0000user' });
    expect(res.status).toBe(422);
  });
});

describe('the one-non-closed-session invariant (partial unique index)', () => {
  it('the schema rejects a second open widget session for the same identity', async () => {
    const { tenant, bot } = await makeAiTenant();
    const visitorId = `idx-${crypto.randomBytes(4).toString('hex')}`;
    await init(bot.publicKey, visitorId);

    const repo = AppDataSource.getRepository(ChatSession);
    await expect(
      repo.save(
        repo.create({
          tenantId: tenant.id,
          botId: bot.id,
          visitorId,
          status: 'bot',
          source: 'widget',
          startedAt: new Date(),
          lastActivityAt: new Date(),
        }),
      ),
    ).rejects.toThrow(/uq_chat_sessions_widget_open|duplicate key/i);

    // A CLOSED duplicate is allowed - the index only guards open sessions.
    await expect(
      repo.save(
        repo.create({
          tenantId: tenant.id,
          botId: bot.id,
          visitorId,
          status: 'closed',
          ownership: 'closed',
          source: 'widget',
          startedAt: new Date(),
          lastActivityAt: new Date(),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('external (channel) sessions are NOT constrained by the widget index', async () => {
    const { tenant, bot } = await makeAiTenant();
    const externalUser = `tg-${crypto.randomBytes(4).toString('hex')}`;
    const repo = AppDataSource.getRepository(ChatSession);
    for (let i = 0; i < 2; i++) {
      await repo.save(
        repo.create({
          tenantId: tenant.id,
          botId: bot.id,
          visitorId: externalUser,
          status: 'bot',
          source: 'telegram',
          channel: 'telegram',
          startedAt: new Date(),
          lastActivityAt: new Date(),
        }),
      );
    }
    const rows = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM chat_sessions
        WHERE tenant_id = $1 AND visitor_id = $2 AND status <> 'closed'`,
      [tenant.id, externalUser],
    );
    expect(rows[0].n).toBe(2);
  });
});

describe('POST /widget/new-conversation - atomic close-and-open', () => {
  it('closes the current session through the command service and opens a new one for the SAME visitor', async () => {
    const { tenant, bot } = await makeAiTenant();
    const visitorId = `newconv-${crypto.randomBytes(4).toString('hex')}`;

    const first = await init(bot.publicKey, visitorId);
    const oldSessionId = first.body.data.session.id as string;

    const res = await newConversation(first.body.data.token);
    expect(res.status).toBe(200);
    expect(res.body.data.isNew).toBe(true);
    expect(res.body.data.closedSessionId).toBe(oldSessionId);
    expect(res.body.data.session.id).not.toBe(oldSessionId);
    expect(res.body.data.customerThreadId).toBe(`w:${tenant.id}:${bot.id}:${visitorId}`);
    expect(res.body.data.token).toBeTruthy();

    // Old session: fully closed (status + ownership) with the system event.
    const [oldRow] = await AppDataSource.query(
      `SELECT status::text AS status, ownership, ended_at FROM chat_sessions WHERE id = $1`,
      [oldSessionId],
    );
    expect(oldRow.status).toBe('closed');
    expect(oldRow.ownership).toBe('closed');
    expect(oldRow.ended_at).not.toBeNull();
    const events = await AppDataSource.getRepository(Message).find({
      where: { sessionId: oldSessionId, type: 'system' },
    });
    expect(events.some((m) => m.content.includes('new conversation'))).toBe(true);

    // Exactly ONE open session for the identity - the new one.
    const open = await openSessions(tenant.id, visitorId);
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(res.body.data.session.id);

    // /init now resolves the NEW session.
    const again = await init(bot.publicKey, visitorId);
    expect(again.body.data.isNew).toBe(false);
    expect(again.body.data.session.id).toBe(res.body.data.session.id);
  });

  it('a STALE token (already-replaced session) still swaps the CURRENT session of the identity', async () => {
    const { tenant, bot } = await makeAiTenant();
    const visitorId = `stale-${crypto.randomBytes(4).toString('hex')}`;

    const first = await init(bot.publicKey, visitorId);
    const staleToken = first.body.data.token as string;
    const swap1 = await newConversation(staleToken);
    const middleSessionId = swap1.body.data.session.id as string;

    // The widget failed to adopt swap1 (e.g. crashed) and retries with the
    // ORIGINAL token: the anchor session is closed, but the identity's current
    // open session (middle) is what must be closed and replaced.
    const swap2 = await newConversation(staleToken);
    expect(swap2.status).toBe(200);
    expect(swap2.body.data.closedSessionId).toBe(middleSessionId);

    const open = await openSessions(tenant.id, visitorId);
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(swap2.body.data.session.id);
  });

  it('rejects without a widget token', async () => {
    const res = await request(app).post('/api/v1/widget/new-conversation').send({});
    expect(res.status).toBe(401);
  });
});
