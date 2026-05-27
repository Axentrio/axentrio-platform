/**
 * Phase 0 coverage for the error-handler middleware (plan §4, §6.1, §6.9):
 *   - `buildErrorResponse` envelope shape for ApiError vs. plain Error.
 *   - `errorHandler` `res.headersSent` guard: logs + delegates without writing.
 *   - `asyncHandler` ZodError → ValidationError adapter (422, VALIDATION_ERROR,
 *     flattened Zod errors in `error.details`).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

// ── Mocks (must come before importing the SUT) ──────────────────────────────
// `vi.hoisted` ensures these mock fns exist when the (also-hoisted) `vi.mock`
// factories below run.

const { loggerError, loggerWarn, loggerInfo, sentryCaptureException, sentrySetContext } =
  vi.hoisted(() => ({
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
    loggerInfo: vi.fn(),
    sentryCaptureException: vi.fn(),
    sentrySetContext: vi.fn(),
  }));

vi.mock('../../utils/logger', () => ({
  logger: {
    error: loggerError,
    warn: loggerWarn,
    info: loggerInfo,
    debug: vi.fn(),
  },
}));

vi.mock('../../config/sentry', () => ({
  Sentry: {
    captureException: sentryCaptureException,
    setContext: sentrySetContext,
  },
}));

vi.mock('../../config/environment', () => ({
  config: {
    server: { isDevelopment: false },
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  ApiError,
  ValidationError,
  asyncHandler,
  buildErrorResponse,
  errorHandler,
} from '../../middleware/error-handler';

// ── Test helpers ────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    requestId: 'req_test_123',
    path: '/api/v1/test',
    method: 'POST',
    user: undefined,
    tenant: undefined,
    ...overrides,
  } as unknown as Request;
}

function makeRes(headersSent = false): Response {
  const res = {
    headersSent,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

beforeEach(() => {
  loggerError.mockReset();
  loggerWarn.mockReset();
  loggerInfo.mockReset();
  sentryCaptureException.mockReset();
  sentrySetContext.mockReset();
});

// ── buildErrorResponse ──────────────────────────────────────────────────────

describe('buildErrorResponse', () => {
  it('produces the standard envelope for an ApiError, including code + details', () => {
    const err = new ApiError('Tenant suspended', 403, 'TENANT_SUSPENDED', {
      tenantId: 'tenant-1',
    });
    const req = makeReq({ path: '/api/v1/tenants/me' });

    const env = buildErrorResponse(err, req);

    expect(env.success).toBe(false);
    expect(env.error.code).toBe('TENANT_SUSPENDED');
    expect(env.error.message).toBe('Tenant suspended');
    expect(env.error.details).toEqual({ tenantId: 'tenant-1' });
    expect(env.meta.requestId).toBe('req_test_123');
    expect(env.meta.path).toBe('/api/v1/tenants/me');
    expect(typeof env.meta.timestamp).toBe('string');
    // No stack in non-development mode.
    expect(env.error.stack).toBeUndefined();
  });

  it('redacts the message of a plain (non-operational) Error to the canned copy', () => {
    const err = new Error('boom: something internal leaked');
    const req = makeReq();

    const env = buildErrorResponse(err, req);

    expect(env.success).toBe(false);
    expect(env.error.code).toBe('INTERNAL_ERROR');
    expect(env.error.message).toBe('An unexpected error occurred');
    expect(env.error.details).toBeUndefined();
    expect(env.meta.requestId).toBe('req_test_123');
  });

  it('falls back to empty-string requestId when none is set on the request', () => {
    const err = new ApiError('Nope', 400, 'BAD_REQUEST');
    const req = makeReq({ requestId: undefined as unknown as string });

    const env = buildErrorResponse(err, req);

    expect(env.meta.requestId).toBe('');
  });
});

// ── errorHandler headersSent guard ──────────────────────────────────────────

describe('errorHandler headersSent guard', () => {
  it('logs the post-response error + Sentry-captures, then delegates without writing', () => {
    const err = new Error('late crash after timeout');
    const req = makeReq();
    const res = makeRes(true); // headers already sent
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(err, req, res, next);

    // Logged with the "response already sent" marker.
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toBe('Server error (response already sent)');
    expect(sentryCaptureException).toHaveBeenCalledWith(err);

    // Did NOT write a body.
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();

    // Delegated to Express's default finalizer.
    expect(next).toHaveBeenCalledWith(err);
  });

  it('logs the normal "Server error" label when headers are not sent yet', () => {
    const err = new Error('regular 500');
    const req = makeReq();
    const res = makeRes(false);
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(err, req, res, next);

    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toBe('Server error');
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledTimes(1);
    // next() must NOT be invoked when we wrote a body.
    expect(next).not.toHaveBeenCalled();
  });
});

// ── asyncHandler ZodError adapter ───────────────────────────────────────────

describe('asyncHandler ZodError → ValidationError adapter', () => {
  it('converts a thrown ZodError into a ValidationError with flattened details', async () => {
    const schema = z.object({ name: z.string(), count: z.number() });

    const handler = asyncHandler(async (req: Request) => {
      // This mimics the `schema.parse(req.body)` pattern used in knowledge/
      // widget-appearance/integrations controllers.
      schema.parse(req.body);
    });

    const req = makeReq({ body: { name: 123, count: 'oops' } } as Partial<Request>);
    const res = makeRes(false);
    const next = vi.fn() as unknown as NextFunction;

    handler(req, res, next);
    // Let the rejected promise propagate to the .catch.
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledTimes(1);
    const forwarded = (next as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(forwarded).toBeInstanceOf(ValidationError);
    const validationErr = forwarded as ValidationError;
    expect(validationErr.statusCode).toBe(422);
    expect(validationErr.code).toBe('VALIDATION_ERROR');
    expect(validationErr.message).toBe('Validation failed');
    // The flattened Zod errors live on `error.details`.
    expect(validationErr.details).toBeDefined();
    expect(validationErr.details).toHaveProperty('fieldErrors');
    const fieldErrors = (validationErr.details as { fieldErrors: Record<string, string[]> })
      .fieldErrors;
    expect(Object.keys(fieldErrors)).toEqual(expect.arrayContaining(['name', 'count']));
  });

  it('passes non-ZodError rejections through unchanged', async () => {
    const original = new ApiError('Already typed', 409, 'CONFLICT');

    const handler = asyncHandler(async () => {
      throw original;
    });

    const req = makeReq();
    const res = makeRes(false);
    const next = vi.fn() as unknown as NextFunction;

    handler(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledWith(original);
  });

  it('feeds the converted ValidationError into errorHandler → 422 envelope on the wire', async () => {
    const schema = z.object({ field: z.string() });

    const handler = asyncHandler(async (req: Request) => {
      schema.parse(req.body);
    });

    const req = makeReq({ body: {} } as Partial<Request>);
    const res = makeRes(false);

    // Chain: asyncHandler → next(ValidationError) → errorHandler writes body.
    const next: NextFunction = (err: unknown) => {
      errorHandler(err as Error, req, res, vi.fn() as unknown as NextFunction);
    };

    handler(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toHaveBeenCalledWith(422);
    const body = (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      success: boolean;
      error: { code: string; details?: { fieldErrors?: Record<string, unknown> } };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.fieldErrors).toBeDefined();
  });
});
