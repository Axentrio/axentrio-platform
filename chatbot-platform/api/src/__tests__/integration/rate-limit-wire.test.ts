/**
 * Wire-envelope test for `rateLimitByIp` + OOS path carve-out
 * (plan §6.2 + §10).
 *
 * Mocks Redis so the limiter falls back to `RateLimiterMemory` and config
 * to a tiny `maxRequests` so we can exhaust the limit cheaply. Same pattern
 * as `middleware-rate-limit-timeout.test.ts`, but driven through Express +
 * supertest so we assert the actual wire body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../config/redis', () => ({
  getRedisClient: () => null,
  isRedisAvailable: () => false,
}));

vi.mock('../../config/environment', () => ({
  config: {
    server: { isDevelopment: false },
    rateLimit: {
      windowMs: 60_000,
      maxRequests: 2, // tiny — exhaust in 2 requests; 3rd is the rejection.
      wsMaxConnections: 5,
    },
    logging: { level: 'error', format: 'simple', toFile: false, filePath: '' },
  },
}));

// Stub logger to avoid winston transports doing real I/O during tests.
vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { rateLimitByIp } from '../../middleware/rate-limit.middleware';
import { errorHandler } from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';

function makeApp(path: string): express.Express {
  const app = express();
  app.use(requestIdMiddleware);
  // `req.ip` reads `req.socket.remoteAddress` by default; that's `::ffff:127.0.0.1`
  // under supertest so consecutive requests share a limiter bucket.
  app.use(rateLimitByIp);
  app.get(path, (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

async function exhaustLimit(app: express.Express, url: string, count: number) {
  for (let i = 0; i < count; i++) {
    // eslint-disable-next-line no-await-in-loop
    await request(app).get(url);
  }
}

beforeEach(() => {
  // The in-memory limiter is module-scoped; sleep slightly so cross-test
  // bleed is unlikely. We rely on each describe block using its own URL so
  // bucket keys (`ip:127.0.0.1` in this case) accumulate across tests within
  // the same file. That's acceptable because each test exhausts to count+1
  // anyway.
});

describe('rateLimitByIp — wire envelope on portal-facing path', () => {
  it('emits envelope 429 / RATE_LIMIT_EXCEEDED with Retry-After header', async () => {
    const app = makeApp('/api/v1/agents');
    await exhaustLimit(app, '/api/v1/agents', 2);

    const res = await request(app).get('/api/v1/agents');

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: expect.any(String),
        details: { retryAfter: expect.any(Number) },
      },
      meta: { requestId: expect.any(String) },
    });
  });
});

describe('rateLimitByIp — OOS carve-out preserves legacy body', () => {
  it.each([
    '/api/v1/webhooks/inbound',
    '/api/v1/webhooks/health',
    '/api/v1/webhooks/events',
    '/api/v1/internal/rag',
    '/api/v1/internal/booking',
    '/api/v1/channels/telegram/webhook',
  ])('%s emits legacy {error, retryAfter, message}', async (url) => {
    const app = makeApp(url);
    await exhaustLimit(app, url, 2);

    const res = await request(app).get(url);

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body).toMatchObject({
      error: 'Too Many Requests',
      retryAfter: expect.any(Number),
      message: 'Rate limit exceeded. Please try again later.',
    });
    // Specifically NOT the new envelope.
    expect(res.body.success).toBeUndefined();
    expect(res.body.meta).toBeUndefined();
  });
});

describe('rateLimitByIp — regex anchoring', () => {
  it('/api/v1/webhook-admin/list does NOT match /webhooks/ — emits new envelope', async () => {
    const app = makeApp('/api/v1/webhook-admin/list');
    await exhaustLimit(app, '/api/v1/webhook-admin/list', 2);

    const res = await request(app).get('/api/v1/webhook-admin/list');

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
