/**
 * Wire-envelope master regression guard.
 *
 * Plan: chatbot-platform/docs/api-response-standardization-plan.md §7.1.
 *
 * For every typed error class — and for a plain non-operational `Error` —
 * mount the global `errorHandler` on a minimal Express app and assert that
 * the response body matches the canonical envelope on the wire:
 *
 *   { success: false, error: { code, message, details? }, meta: { ... } }
 *
 * This is the contract every later migration phase MUST keep stable.
 */

import { describe, it, expect } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

import {
  ApiError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  errorHandler,
  asyncHandler,
} from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';

function makeApp(setup: (app: express.Express) => void): express.Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  setup(app);
  app.use(errorHandler);
  return app;
}

const ENVELOPE_META = {
  timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  requestId: expect.any(String),
  path: expect.any(String),
};

describe('error envelope — typed errors', () => {
  it.each([
    { Cls: BadRequestError, code: 'BAD_REQUEST', status: 400, msg: 'bad' },
    { Cls: UnauthorizedError, code: 'UNAUTHORIZED', status: 401, msg: 'unauth' },
    { Cls: ForbiddenError, code: 'FORBIDDEN', status: 403, msg: 'nope' },
    { Cls: NotFoundError, code: 'NOT_FOUND', status: 404, msg: 'missing' },
    { Cls: ConflictError, code: 'CONFLICT', status: 409, msg: 'conflict' },
    { Cls: ValidationError, code: 'VALIDATION_ERROR', status: 422, msg: 'invalid' },
    { Cls: RateLimitError, code: 'RATE_LIMIT_EXCEEDED', status: 429, msg: 'too many' },
  ])(
    'emits envelope on the wire for $Cls.name → $status / $code',
    async ({ Cls, code, status, msg }) => {
      const app = makeApp((a) => {
        a.get('/throw', () => {
          throw new (Cls as new (m: string) => ApiError)(msg);
        });
      });

      const res = await request(app).get('/throw');

      expect(res.status).toBe(status);
      expect(res.body).toEqual({
        success: false,
        error: { code, message: msg },
        meta: { ...ENVELOPE_META, path: '/throw' },
      });
      expect(res.body.meta.requestId).not.toBe('');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    },
  );

  it('preserves details for ApiError(..., status, code, details)', async () => {
    const app = makeApp((a) => {
      a.get('/custom', () => {
        throw new ApiError('upstream blew up', 502, 'UPSTREAM_FAILED', {
          providerName: 'stripe',
          attempt: 2,
        });
      });
    });

    const res = await request(app).get('/custom');

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'UPSTREAM_FAILED',
        message: 'upstream blew up',
        details: { providerName: 'stripe', attempt: 2 },
      },
      meta: { ...ENVELOPE_META, path: '/custom' },
    });
  });

  it('redacts a non-operational plain Error to the canned message', async () => {
    const app = makeApp((a) => {
      a.get('/boom', () => {
        throw new Error('internal: db cred leaked into stack');
      });
    });

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      meta: { ...ENVELOPE_META, path: '/boom' },
    });
  });

  it('propagates async rejections through asyncHandler → errorHandler', async () => {
    const app = makeApp((a) => {
      a.get(
        '/async-throw',
        asyncHandler(async (_req: Request, _res: Response, _next: NextFunction) => {
          throw new NotFoundError('async-missing');
        }),
      );
    });

    const res = await request(app).get('/async-throw');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('async-missing');
  });

  it('meta.requestId comes from the X-Request-ID header when provided', async () => {
    const app = makeApp((a) => {
      a.get('/throw', () => {
        throw new BadRequestError('x');
      });
    });

    const res = await request(app)
      .get('/throw')
      .set('x-request-id', 'req_test_abcdef');

    expect(res.body.meta.requestId).toBe('req_test_abcdef');
    // Header is also echoed back.
    expect(res.headers['x-request-id']).toBe('req_test_abcdef');
  });

  it('meta.requestId is a non-empty UUID when no header was supplied', async () => {
    const app = makeApp((a) => {
      a.get('/throw', () => {
        throw new BadRequestError('x');
      });
    });

    const res = await request(app).get('/throw');
    // requestIdMiddleware uses crypto.randomUUID() when no header is set.
    expect(res.body.meta.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
