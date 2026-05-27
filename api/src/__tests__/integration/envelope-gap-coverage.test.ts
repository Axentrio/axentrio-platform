/**
 * Gap-coverage integration tests for the response standardization migration.
 *
 * The eight wire-envelope test files cover the high-traffic paths; this file
 * fills the remaining contract corners that are easy to regress because
 * nothing else exercises them:
 *
 *   - `sendNoContent(res)`            → 204 + empty body.
 *   - `sendPaginated(res, data, p)`   → 200 + { success, data, meta: { pagination } }.
 *   - `notFoundHandler` (global)      → 404 envelope for unknown routes.
 *   - `RATE_LIMIT_FALLBACK` code      → wire envelope when the limiter falls back.
 *   - `TENANT_SUSPENDED` code         → wire envelope (matches clerk.middleware L219 throw).
 *   - `PROVISIONING_FAILED` code      → wire envelope (matches clerk.middleware L193 / L303 / L355 throws).
 *
 * Dev-mode envelope details (message NOT redacted + stack included) live in
 * `envelope-dev-mode.test.ts` because `config.server.isDevelopment` is fixed
 * at module load and would race with the production-mode tests in this file.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import {
  ApiError,
  errorHandler,
  notFoundHandler,
} from '../../middleware/error-handler';
import {
  sendNoContent,
  sendPaginated,
} from '../../utils/response';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';
import { ERROR_CODES } from '../../middleware/error-codes';

function makeApp(setup: (app: express.Express) => void): express.Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  setup(app);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const ENVELOPE_META = {
  timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  requestId: expect.any(String),
  path: expect.any(String),
};

// ─── sendNoContent (204) ────────────────────────────────────────────────────

describe('sendNoContent — wire shape', () => {
  it('emits 204 with an empty body', async () => {
    const app = makeApp((a) => {
      a.delete('/widget/1', (_req, res) => sendNoContent(res));
    });

    const res = await request(app).delete('/widget/1');

    expect(res.status).toBe(204);
    // 204 responses MUST NOT have a body per RFC 7230 §3.3.3.
    expect(res.body).toEqual({});
    expect(res.text).toBe('');
    expect(res.headers['content-length']).toBeUndefined();
  });
});

// ─── sendPaginated — meta.pagination contract ───────────────────────────────

describe('sendPaginated — wire shape', () => {
  it('emits envelope with meta.pagination on the wire', async () => {
    const app = makeApp((a) => {
      a.get('/widgets', (_req, res) => {
        sendPaginated(
          res,
          [{ id: '1' }, { id: '2' }, { id: '3' }],
          { page: 2, limit: 3, total: 50, totalPages: 17 },
        );
      });
    });

    const res = await request(app).get('/widgets');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [{ id: '1' }, { id: '2' }, { id: '3' }],
      meta: {
        pagination: { page: 2, limit: 3, total: 50, totalPages: 17 },
      },
    });
  });

  it('preserves empty data arrays with a valid pagination block', async () => {
    const app = makeApp((a) => {
      a.get('/empty', (_req, res) => {
        sendPaginated(res, [], { page: 1, limit: 10, total: 0, totalPages: 0 });
      });
    });

    const res = await request(app).get('/empty');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.pagination).toEqual({ page: 1, limit: 10, total: 0, totalPages: 0 });
  });
});

// ─── notFoundHandler — unknown routes ───────────────────────────────────────

describe('notFoundHandler — wire envelope for unknown routes', () => {
  it('emits 404 envelope with NOT_FOUND code + path in the message', async () => {
    const app = makeApp((a) => {
      a.get('/known', (_req, res) => res.json({ ok: true }));
    });

    const res = await request(app).get('/this-route-does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Route GET /this-route-does-not-exist not found',
      },
      meta: { ...ENVELOPE_META, path: '/this-route-does-not-exist' },
    });
    expect(res.body.meta.requestId).not.toBe('');
  });

  it('returns the method-prefixed message for non-GET requests', async () => {
    const app = makeApp(() => {
      /* no routes mounted */
    });

    const res = await request(app).post('/missing');

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Route POST /missing not found');
  });
});

// ─── typed errors with the migration's custom codes ─────────────────────────

describe('ApiError with migration-specific codes — wire envelope shape', () => {
  it.each([
    {
      label: 'TENANT_SUSPENDED — matches clerk.middleware L219 path',
      err: () =>
        new ApiError('Organization suspended', 403, ERROR_CODES.TENANT_SUSPENDED),
      status: 403,
      code: 'TENANT_SUSPENDED',
      message: 'Organization suspended',
    },
    {
      label: 'PROVISIONING_FAILED — matches clerk.middleware L193 / L303 / L355',
      err: () =>
        new ApiError(
          'Failed to provision tenant',
          500,
          ERROR_CODES.PROVISIONING_FAILED,
        ),
      status: 500,
      code: 'PROVISIONING_FAILED',
      message: 'Failed to provision tenant',
    },
    {
      label: 'RATE_LIMIT_FALLBACK — matches rate-limit fallback branch',
      err: () =>
        new ApiError(
          'Rate limit exceeded (fallback). Please try again later.',
          429,
          ERROR_CODES.RATE_LIMIT_FALLBACK,
        ),
      status: 429,
      code: 'RATE_LIMIT_FALLBACK',
      message: 'Rate limit exceeded (fallback). Please try again later.',
    },
    {
      label: 'NOT_IMPLEMENTED — matches analytics.routes L219',
      err: () =>
        new ApiError(
          'Analytics export not yet implemented',
          501,
          ERROR_CODES.NOT_IMPLEMENTED,
        ),
      status: 501,
      code: 'NOT_IMPLEMENTED',
      message: 'Analytics export not yet implemented',
    },
    {
      label: 'FILE_SERVICE_UNAVAILABLE — matches files.routes L32 / L84 / L115',
      err: () =>
        new ApiError(
          'File service is not configured',
          503,
          ERROR_CODES.FILE_SERVICE_UNAVAILABLE,
        ),
      status: 503,
      code: 'FILE_SERVICE_UNAVAILABLE',
      message: 'File service is not configured',
    },
    {
      label: 'CLERK_UPSTREAM_FAILED — matches admin.routes L114 / L332 / L704',
      err: () =>
        new ApiError(
          'Failed to send invite via Clerk',
          502,
          ERROR_CODES.CLERK_UPSTREAM_FAILED,
        ),
      status: 502,
      code: 'CLERK_UPSTREAM_FAILED',
      message: 'Failed to send invite via Clerk',
    },
  ])('emits envelope for $label', async ({ err, status, code, message }) => {
    const app = makeApp((a) => {
      a.get('/throw', () => {
        throw err();
      });
    });

    const res = await request(app).get('/throw');

    expect(res.status).toBe(status);
    expect(res.body).toEqual({
      success: false,
      error: { code, message },
      meta: { ...ENVELOPE_META, path: '/throw' },
    });
  });
});
