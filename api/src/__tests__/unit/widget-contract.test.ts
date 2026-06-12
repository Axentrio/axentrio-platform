import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Contract tests for the widget API — the product's front door.
 * Covers /init validation + bot-key resolution states + session creation,
 * and /message auth. The widget token round-trip is REAL (generateWidgetToken
 * → authenticateWidget), so token-shape regressions fail here.
 */

const st = vi.hoisted(() => ({
  resolveResult: null as Record<string, unknown> | null,
  resolveError: null as Error | null,
  existingSession: null as Record<string, unknown> | null,
  savedSessions: [] as Array<Record<string, unknown>>,
  sessionById: null as Record<string, unknown> | null,
}));

const errs = vi.hoisted(() => {
  class BotPausedError extends Error {}
  class BotNotFoundError extends Error {}
  return { BotPausedError, BotNotFoundError };
});

vi.mock('../../services/bot-resolution.service', () => ({
  BotPausedError: errs.BotPausedError,
  BotNotFoundError: errs.BotNotFoundError,
  resolveBotKeyStrict: async () => {
    if (st.resolveError) throw st.resolveError;
    return st.resolveResult;
  },
}));

vi.mock('../../middleware/rate-limit', () => ({
  widgetRateLimiter: (_req: any, _res: any, next: any) => next(),
  simpleRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({ emitToSession: vi.fn() }));
vi.mock('../../services/message-forwarding.service', () => ({ forwardMessageToN8n: vi.fn() }));
vi.mock('../../widget/widget-version', () => ({ widgetVersionHash: 'test', widgetPath: '/tmp/widget.js' }));
vi.mock('../../billing/enforce', () => ({
  enforceCountLimit: vi.fn(async () => {}),
  requireFeature: vi.fn(async () => {}),
}));
vi.mock('../../billing/entitlements', () => ({
  getEntitlements: async () => ({ features: { fileUpload: true, handoff: true } }),
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'ChatSession') {
        return {
          findOne: async ({ where }: any) =>
            where?.id ? st.sessionById : st.existingSession,
        };
      }
      if (entity.name === 'Participant') {
        return {
          create: (p: Record<string, unknown>) => p,
          save: async (p: Record<string, unknown>) => ({ ...p, id: 'part-1' }),
          findOne: async () => null,
        };
      }
      if (entity.name === 'Message') {
        return {
          create: (m: Record<string, unknown>) => m,
          save: async (m: Record<string, unknown>) => ({ ...m, id: 'msg-1' }),
          find: async () => [],
          findAndCount: async () => [[], 0],
        };
      }
      return { findOne: async () => null, find: async () => [], create: (x: unknown) => x, save: async (x: unknown) => x };
    },
    transaction: async (fn: (m: unknown) => unknown) =>
      fn({
        count: async () => 0,
        create: (_e: unknown, draft: Record<string, unknown>) => draft,
        save: async (_e: unknown, draft: Record<string, unknown>) => {
          const saved = { ...draft, id: 'sess-new' };
          st.savedSessions.push(saved);
          return saved;
        },
      }),
  },
}));

// ── Imports after mocks ─────────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import { widgetRouter } from '../../routes/widget';
import { errorHandler } from '../../middleware/error-handler';
import { generateWidgetToken } from '../../middleware/auth.middleware';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/widget', widgetRouter);
  app.use(errorHandler);
  return app;
}

const TENANT = { id: 'tenant-1', settings: {} };
const BOT = { id: 'bot-1', settings: { ai: { enabled: true } } };

beforeEach(() => {
  st.resolveResult = { tenant: TENANT, bot: BOT };
  st.resolveError = null;
  st.existingSession = null;
  st.savedSessions = [];
  st.sessionById = null;
});

describe('POST /widget/init — validation + key resolution', () => {
  it('422s without apiKey or visitorId (ValidationError contract)', async () => {
    const app = createApp();
    expect((await request(app).post('/widget/init').send({ visitorId: 'v1' })).status).toBe(422);
    expect((await request(app).post('/widget/init').send({ apiKey: 'k' })).status).toBe(422);
  });

  it('403s for a paused bot (not 400 — the widget shows an unavailable state)', async () => {
    st.resolveError = new errs.BotPausedError('paused');
    const res = await request(createApp()).post('/widget/init').send({ apiKey: 'k', visitorId: 'v1' });
    expect(res.status).toBe(403);
  });

  it('422s for an unknown bot key', async () => {
    st.resolveError = new errs.BotNotFoundError('nope');
    const res = await request(createApp()).post('/widget/init').send({ apiKey: 'bad', visitorId: 'v1' });
    expect(res.status).toBe(422);
  });

  it('creates a session for a new visitor and returns a usable token', async () => {
    const res = await request(createApp())
      .post('/widget/init')
      .send({ apiKey: 'k', visitorId: 'v-new' });
    expect(res.status).toBeLessThan(300);
    expect(res.body.data.session.id).toBe('sess-new');
    expect(res.body.data.isNew).toBe(true);
    expect(typeof res.body.data.token).toBe('string');
    expect(st.savedSessions[0]).toMatchObject({
      tenantId: 'tenant-1',
      botId: 'bot-1',
      visitorId: 'v-new',
      source: 'widget',
      status: 'bot', // AI enabled → bot, not waiting
    });
  });

  it('reuses an active session for a returning visitor', async () => {
    st.existingSession = { id: 'sess-old', status: 'active', startedAt: new Date(), botId: 'bot-1' };
    const res = await request(createApp())
      .post('/widget/init')
      .send({ apiKey: 'k', visitorId: 'v-back' });
    expect(res.body.data.session.id).toBe('sess-old');
    expect(res.body.data.isNew).toBe(false);
    expect(st.savedSessions).toHaveLength(0);
  });
});

describe('POST /widget/message — auth contract', () => {
  it('401s without a widget token', async () => {
    const res = await request(createApp()).post('/widget/message').send({ content: 'hi' });
    expect(res.status).toBe(401);
  });

  it('401s with a garbage token', async () => {
    const res = await request(createApp())
      .post('/widget/message')
      .set('Authorization', 'Bearer not-a-jwt')
      .send({ content: 'hi' });
    expect(res.status).toBe(401);
  });

  it('accepts a real token but 422s without content', async () => {
    const token = generateWidgetToken('sess-1', 'tenant-1', 'v1');
    const res = await request(createApp())
      .post('/widget/message')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(422);
  });

  it('404s a token whose session no longer exists (tenant-scoped lookup)', async () => {
    st.sessionById = null;
    const token = generateWidgetToken('sess-gone', 'tenant-1', 'v1');
    const res = await request(createApp())
      .post('/widget/message')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'hi' });
    expect(res.status).toBe(404);
  });
});
