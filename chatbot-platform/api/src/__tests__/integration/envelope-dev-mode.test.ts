/**
 * Dev-mode contract for `buildErrorResponse`.
 *
 * When `config.server.isDevelopment === true`:
 *   - The plain-Error message is NOT redacted (developers see the real message).
 *   - The `error.stack` field is populated.
 *
 * This file mocks `config/environment` to force `isDevelopment: true` for the
 * whole test module. It lives in its own file because `vi.mock` is hoisted
 * and module-scoped — co-locating it with production-mode tests would race.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/environment', () => ({
  config: {
    server: { isDevelopment: true },
  },
}));

// Stub logger so winston transports don't try to do real I/O while the env mock
// is in place (logger reads config.logging which the mock above omits).
vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/sentry', () => ({
  Sentry: { captureException: vi.fn(), setContext: vi.fn() },
}));

import express from 'express';
import request from 'supertest';
import { ApiError, errorHandler } from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';

function makeApp(setup: (app: express.Express) => void): express.Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  setup(app);
  app.use(errorHandler);
  return app;
}

describe('buildErrorResponse — dev mode', () => {
  it('does NOT redact the message of a plain (non-operational) Error', async () => {
    const app = makeApp((a) => {
      a.get('/boom', () => {
        throw new Error('internal: db cred would normally be redacted');
      });
    });

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    // In production this becomes "An unexpected error occurred". In dev the
    // real message reaches the client.
    expect(res.body.error.message).toBe(
      'internal: db cred would normally be redacted',
    );
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('includes the stack trace on the response', async () => {
    const app = makeApp((a) => {
      a.get('/boom', () => {
        throw new Error('detailed stack please');
      });
    });

    const res = await request(app).get('/boom');

    expect(res.body.error.stack).toBeDefined();
    expect(typeof res.body.error.stack).toBe('string');
    // Stack should reference the thrower (the route handler in this test).
    expect(res.body.error.stack as string).toMatch(/Error: detailed stack please/);
  });

  it('still preserves the operational ApiError message + code', async () => {
    const app = makeApp((a) => {
      a.get('/conflict', () => {
        throw new ApiError('Already exists', 409, 'CONFLICT', { id: 'x' });
      });
    });

    const res = await request(app).get('/conflict');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toBe('Already exists');
    expect(res.body.error.details).toEqual({ id: 'x' });
    // ApiError stack still attached in dev mode.
    expect(res.body.error.stack).toBeDefined();
  });
});
