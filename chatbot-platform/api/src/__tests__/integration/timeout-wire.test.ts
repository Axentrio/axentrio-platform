/**
 * Wire-envelope test for `timeoutMiddleware` + OOS path carve-out
 * (plan §6.1 + §10).
 *
 * Portal paths get the new envelope. The six OOS paths (n8n inbound/health/
 * events, internal/rag, internal/booking, channels/:c/webhook) keep the
 * legacy `{error:'Request timeout'}` body so integration partners' clients
 * don't break.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { timeoutMiddleware } from '../../middleware/timeout.middleware';
import { errorHandler } from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';

const TIMEOUT_MS = 50;
const HANDLER_DELAY_MS = 200;

function makeApp(): express.Express {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(timeoutMiddleware(TIMEOUT_MS));
  app.use((_req, res, next) => {
    // Slow handler — gives the timeout middleware time to fire.
    setTimeout(() => {
      if (!res.headersSent) {
        res.json({ ok: true });
      }
      next();
    }, HANDLER_DELAY_MS);
  });
  app.use(errorHandler);
  return app;
}

describe('timeoutMiddleware — wire envelope on portal paths', () => {
  it('emits the new envelope for a portal-facing URL', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/v1/tenants/me');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'REQUEST_TIMEOUT',
        message: 'Request timeout',
      },
      meta: {
        requestId: expect.any(String),
        path: expect.any(String),
        timestamp: expect.any(String),
      },
    });
    expect(res.body.meta.requestId).not.toBe('');
  });
});

describe('timeoutMiddleware — OOS carve-out preserves legacy body', () => {
  it.each([
    '/api/v1/webhooks/inbound',
    '/api/v1/webhooks/health',
    '/api/v1/webhooks/events',
    '/api/v1/internal/rag',
    '/api/v1/internal/booking',
    '/api/v1/channels/telegram/webhook',
    '/api/v1/channels/meta/webhook',
  ])('%s gets the legacy {error:"Request timeout"} body', async (url) => {
    const app = makeApp();
    const res = await request(app).get(url);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Request timeout' });
    // Specifically NOT the new envelope.
    expect(res.body.success).toBeUndefined();
    expect(res.body.meta).toBeUndefined();
  });

  it('regex anchoring: /api/v1/webhook-admin/list is NOT OOS', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/v1/webhook-admin/list');

    expect(res.status).toBe(503);
    // New envelope — proves /webhooks/... anchor does not bleed into /webhook-admin/...
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('REQUEST_TIMEOUT');
  });
});
