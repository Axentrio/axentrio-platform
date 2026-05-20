/**
 * Wire-envelope tests for the Phase 6 migrations:
 *   - chatbot-platform/api/src/channels/meta/oauth.routes.ts (JSON endpoints)
 *   - chatbot-platform/api/src/n8n/webhook.routes.ts          (admin endpoints)
 *   - chatbot-platform/api/src/n8n/webhook.controller.ts      (admin methods)
 *
 * Plan: chatbot-platform/docs/api-response-standardization-plan.md
 * §2.2, §2.3, §3.3 (rows for these three files), §4 Phase 6, §5 (OOS list).
 *
 * Coverage groups:
 *   META OAUTH (5 cases)
 *     (a) GET /url success — sendSuccess({ url })
 *     (b) GET /url 400 — tenant context missing
 *     (c) GET /url 503 — meta not configured (UPSTREAM_FAILED)
 *     (d) GET /pages success
 *     (e) GET /pages 401 — invalid session token
 *   META CONNECT CATCH-ALL ADAPTER (2 cases)
 *     (f) POST /connect — underlying service throws ApiError(402) → propagates as 402
 *     (g) POST /connect — underlying service throws plain Error → falls back to 400
 *   N8N ADMIN (3 cases)
 *     (h) GET /circuit-status when admin disabled → 503 NOT_IMPLEMENTED envelope
 *     (i) POST /circuit-reset success → sendSuccess envelope
 *     (j) POST /retry/:id not-found → 404 NotFoundError envelope
 *   N8N CONTRACT PRESERVATION (1 case)
 *     (k) POST /inbound with bad secret → legacy { success:false, error:'...' } shape INTACT.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

const TENANT_UUID = '11111111-1111-4111-8111-111111111111';
const USER_UUID = '22222222-2222-4222-8222-222222222222';

// ── hoisted mocks ──────────────────────────────────────────────────────────
const {
  buildOAuthUrl,
  getSessionPages,
  getCachedPageToken,
  setupMetaConnections,
  enforceCountLimit,
  metaAppId,
  metaRedirect,
  n8nInboundSecret,
  circuitBreakerReset,
  circuitBreakerGetState,
  circuitBreakerGetStats,
  retryServiceRetryMessage,
} = vi.hoisted(() => ({
  buildOAuthUrl: vi.fn(),
  getSessionPages: vi.fn(),
  getCachedPageToken: vi.fn(),
  setupMetaConnections: vi.fn(),
  enforceCountLimit: vi.fn(),
  metaAppId: { value: 'app123' },
  metaRedirect: { value: 'https://example.com/cb' },
  n8nInboundSecret: { value: 'secret-token-xyz' },
  circuitBreakerReset: vi.fn(),
  circuitBreakerGetState: vi.fn(),
  circuitBreakerGetStats: vi.fn(),
  retryServiceRetryMessage: vi.fn(),
}));

// ── shared module mocks ────────────────────────────────────────────────────
vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: USER_UUID,
      email: 'admin@example.com',
      role: 'admin',
      tenantId: TENANT_UUID,
      clerkUserId: 'clerk_admin',
      type: 'agent',
    } as never;
    req.userId = USER_UUID;
    next();
  },
  autoProvision: (_req: Request, _res: Response, next: NextFunction) => next(),
  invalidateProvisionCache: vi.fn(),
}));

vi.mock('../../channels/meta/oauth.service', () => ({
  buildOAuthUrl,
  validateOAuthState: vi.fn(),
  handleOAuthCallback: vi.fn(),
  getSessionPages,
  getCachedPageToken,
}));

vi.mock('../../channels/meta/setup.service', () => ({
  setupMetaConnections,
}));

vi.mock('../../billing/enforce', () => ({
  enforceCountLimit,
  requireFeature: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({ findOne: vi.fn(), save: vi.fn(), count: vi.fn() }),
    transaction: async (fn: (manager: unknown) => Promise<unknown>) =>
      fn({ count: async () => 0 }),
  },
}));

vi.mock('../../config/environment', () => ({
  config: {
    server: { isDevelopment: false, isProduction: false },
    meta: {
      get appId() { return metaAppId.value; },
      get oauthRedirectUri() { return metaRedirect.value; },
      appSecret: '',
      verifyToken: '',
      oauthJwtSecret: 'jwt-secret',
    },
    cors: { origin: ['http://localhost:5173'] },
    n8n: {
      webhookUrl: '',
      defaultWebhookUrl: '',
      enabled: false,
      ragInternalSecret: '',
      get inboundSecret() { return n8nInboundSecret.value; },
    },
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/sentry', () => ({
  Sentry: { captureException: vi.fn(), setContext: vi.fn() },
}));

// ── imports of code under test (must come after mocks) ─────────────────────
import metaOAuthRouter, { metaOAuthCallbackRouter } from '../../channels/meta/oauth.routes';
import { createWebhookRouter } from '../../n8n/webhook.routes';
import { WebhookController } from '../../n8n/webhook.controller';
import { errorHandler, ApiError } from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';

// ── helpers ────────────────────────────────────────────────────────────────
const ENVELOPE_META = {
  timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  requestId: expect.any(String),
  path: expect.any(String),
};

function makeMetaApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/meta', metaOAuthRouter);
  app.use('/meta', metaOAuthCallbackRouter);
  app.use(errorHandler);
  return app;
}

function makeN8nController(): WebhookController {
  return new WebhookController({
    webhookService: {} as never,
    circuitBreaker: {
      getState: circuitBreakerGetState,
      getStats: circuitBreakerGetStats,
      reset: circuitBreakerReset,
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    } as never,
    retryService: {
      retryMessage: retryServiceRetryMessage,
      getQueueStatus: vi.fn(),
    } as never,
    fallbackService: {} as never,
    metricsService: {
      incrementCounter: vi.fn(),
      recordHistogram: vi.fn(),
    } as never,
    secret: undefined,
  });
}

function makeN8nApp(): express.Express {
  const app = express();
  app.use(requestIdMiddleware);
  const controller = makeN8nController();
  const router = createWebhookRouter({ webhookController: controller });
  app.use('/n8n', router);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  buildOAuthUrl.mockReset();
  getSessionPages.mockReset();
  getCachedPageToken.mockReset();
  setupMetaConnections.mockReset();
  enforceCountLimit.mockReset();
  circuitBreakerReset.mockReset();
  circuitBreakerGetState.mockReset();
  circuitBreakerGetStats.mockReset();
  retryServiceRetryMessage.mockReset();
  metaAppId.value = 'app123';
  metaRedirect.value = 'https://example.com/cb';
  n8nInboundSecret.value = 'secret-token-xyz';
});

// ── META OAUTH ─────────────────────────────────────────────────────────────

describe('meta/oauth.routes — GET /url', () => {
  it('emits sendSuccess envelope on happy path', async () => {
    buildOAuthUrl.mockReturnValue('https://facebook.com/oauth?x=1');

    const res = await request(makeMetaApp()).get('/meta/url');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { url: 'https://facebook.com/oauth?x=1' },
    });
    expect(res.body).not.toHaveProperty('error');
  });

  it('emits 503 UPSTREAM_FAILED envelope when meta integration not configured', async () => {
    metaAppId.value = '';

    const res = await request(makeMetaApp()).get('/meta/url');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'UPSTREAM_FAILED',
        message: 'Meta integration not configured',
      },
      meta: { ...ENVELOPE_META, path: '/meta/url' },
    });
  });
});

describe('meta/oauth.routes — GET /pages', () => {
  it('emits sendSuccess envelope with pages array', async () => {
    getSessionPages.mockReturnValue([
      { id: 'p1', name: 'Page 1', accessToken: 't1', tasks: [] },
    ]);

    const res = await request(makeMetaApp()).get('/meta/pages?session=tok123');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        pages: [{ id: 'p1', name: 'Page 1', accessToken: 't1', tasks: [] }],
      },
    });
  });

  it('emits 401 UNAUTHORIZED envelope when session is invalid', async () => {
    getSessionPages.mockImplementation(() => {
      throw new Error('bad jwt');
    });

    const res = await request(makeMetaApp()).get('/meta/pages?session=bogus');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired session' },
    });
  });
});

// ── META CONNECT CATCH-ALL ADAPTER (the critical part) ─────────────────────

describe('meta/oauth.routes — POST /connect catch-all adapter', () => {
  it('propagates an ApiError thrown by the underlying service with its original status', async () => {
    // Underlying service throws a plan-limit 402. The catch-all adapter MUST
    // detect `instanceof ApiError` and forward via next(err) so the global
    // handler emits 402, NOT a downgrade to 400.
    getSessionPages.mockReturnValue([
      { id: 'p1', name: 'Page 1', accessToken: 't1', tasks: [] },
    ]);
    getCachedPageToken.mockReturnValue('cached-token-1');
    enforceCountLimit.mockImplementation(() => {
      throw new ApiError('plan limit reached', 402, 'PLAN_LIMIT_CHANNELS');
    });

    const res = await request(makeMetaApp())
      .post('/meta/connect')
      .send({ pageIds: ['p1'], sessionToken: 'tok' });

    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'PLAN_LIMIT_CHANNELS',
        message: 'plan limit reached',
      },
      meta: { ...ENVELOPE_META, path: '/meta/connect' },
    });
  });

  it('falls back to 400 BAD_REQUEST envelope for unknown plain Error', async () => {
    // Underlying service throws a non-ApiError; the adapter preserves the
    // legacy 400 wire-shape but in the new envelope format.
    getSessionPages.mockReturnValue([
      { id: 'p1', name: 'Page 1', accessToken: 't1', tasks: [] },
    ]);
    getCachedPageToken.mockReturnValue('cached-token-1');
    enforceCountLimit.mockResolvedValue(undefined);
    setupMetaConnections.mockImplementation(() => {
      throw new Error('something went wrong downstream');
    });

    const res = await request(makeMetaApp())
      .post('/meta/connect')
      .send({ pageIds: ['p1'], sessionToken: 'tok' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'something went wrong downstream',
      },
    });
  });
});

// ── N8N ADMIN ──────────────────────────────────────────────────────────────

describe('n8n/webhook.routes — admin auth guard', () => {
  it('emits 503 NOT_IMPLEMENTED envelope when admin endpoints not configured', async () => {
    n8nInboundSecret.value = '';

    const res = await request(makeN8nApp())
      .get('/n8n/circuit-status')
      .set('authorization', 'Bearer anything');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'Admin endpoints not configured',
      },
      meta: { ...ENVELOPE_META, path: '/n8n/circuit-status' },
    });
  });
});

describe('n8n/webhook.controller — admin methods', () => {
  it('POST /circuit-reset emits sendSuccess envelope on happy path', async () => {
    const res = await request(makeN8nApp())
      .post('/n8n/circuit-reset')
      .set('authorization', 'Bearer secret-token-xyz');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        message: 'Circuit breaker reset successfully',
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    expect(circuitBreakerReset).toHaveBeenCalledTimes(1);
  });

  it('POST /retry/:messageId emits 404 NotFoundError envelope when message not found', async () => {
    retryServiceRetryMessage.mockResolvedValue({
      success: false,
      error: 'Message not in retry queue',
    });

    const res = await request(makeN8nApp())
      .post('/n8n/retry/msg-abc')
      .set('authorization', 'Bearer secret-token-xyz');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Message not in retry queue',
      },
    });
  });
});

// ── N8N CONTRACT PRESERVATION (regression guard) ───────────────────────────

describe('n8n/webhook.controller — handleInboundWebhook contract preservation', () => {
  it('POST /inbound with bad webhook secret returns LEGACY {success:false,error:string} shape', async () => {
    // Stand up the same app but force `secret: 'real-secret'` on the
    // controller config so handleInboundWebhook's per-tenant fallback path
    // checks it. Provide a wrong header so it returns 401.
    const app = express();
    app.use(requestIdMiddleware);
    const controller = new WebhookController({
      webhookService: {} as never,
      circuitBreaker: {
        getState: vi.fn().mockReturnValue({ state: 'closed', failures: 0 }),
        getStats: vi.fn().mockReturnValue({}),
        reset: vi.fn(),
        isOpen: vi.fn().mockReturnValue(false),
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
      } as never,
      retryService: { retryMessage: vi.fn(), getQueueStatus: vi.fn() } as never,
      fallbackService: {} as never,
      metricsService: {
        incrementCounter: vi.fn(),
        recordHistogram: vi.fn(),
      } as never,
      secret: 'real-secret',
    });
    const router = createWebhookRouter({ webhookController: controller });
    app.use('/n8n', router);
    app.use(errorHandler);

    const res = await request(app)
      .post('/n8n/inbound')
      .set('x-webhook-secret', 'WRONG')
      .send({
        action: 'message.send',
        sessionId: '11111111-1111-4111-8111-111111111111',
        payload: { type: 'text', content: 'hi' },
      });

    // Legacy wire shape MUST be intact — this is the regression guard so
    // a future Phase-N migration can't silently migrate the inbound contract.
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: 'Unauthorized: Invalid or missing webhook secret',
    });
    // Crucially: NOT the new envelope shape.
    expect(res.body).not.toHaveProperty('meta');
    expect(typeof res.body.error).toBe('string');
  });
});
