/**
 * Phase 5C — upload.controller envelope migration shapes.
 *
 * Plan: chatbot-platform/docs/api-response-standardization-plan.md
 *   §3.3 (`file-handling/upload.controller.ts` row),
 *   §3.4a (status preservation),
 *   §6.4 (multer adapter pattern),
 *   §4 Phase 5.
 *
 * IMPORTANT: `uploadRouter` is NOT mounted anywhere in the codebase today
 * (repo-wide `grep "uploadRouter\\|getUploadController"` shows only the export
 * line). This file is migrated as cleanup-only — the migration is verified
 * in isolation so the router is ready when it eventually gets mounted.
 *
 * Verifies (lightweight, per the agent brief — wire-test depth is lower for
 * an unmounted router):
 *   1. One success path produces the `{ success: true, data }` envelope.
 *   2. One error path (express-validator `handleValidationErrors`) produces
 *      the typed-error envelope with `error.code === 'VALIDATION_ERROR'`
 *      and `error.details.fieldErrors`.
 *   3. `uploadErrorAdapter` converts a fake `multer.MulterError` to an
 *      `ApiError` with status 400 and the multer code preserved.
 *   4. `uploadErrorAdapter` converts `FileValidationError` to
 *      `ApiError(400, 'FILE_VALIDATION_FAILED')`.
 *   5. `uploadErrorAdapter` converts `QuotaExceededError` to
 *      `ApiError(429, 'QUOTA_EXCEEDED')`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import multer from 'multer';

// ─── Mocks (must come before importing the controller) ─────────────────────

// Stub the JWT auth middleware so we can exercise the validation handler
// without minting tokens. The real auth path is covered by Phase 2 tests.
vi.mock('../../security/auth.middleware', () => ({
  authenticateAgent: (_req: Request, _res: Response, next: NextFunction): void => {
    // populate the request fields the controller reads downstream
    (_req as Request & { tenantId?: string; userId?: string }).tenantId = 'tenant-test';
    (_req as Request & { tenantId?: string; userId?: string }).userId = 'user-test';
    next();
  },
}));

// All four downstream services have side-effecting initializers; stub them.
vi.mock('../../file-handling/upload.service', async () => {
  // Re-export the real error classes so `instanceof` checks in the adapter
  // resolve to the same constructors the tests import.
  const actual = await vi.importActual<typeof import('../../file-handling/upload.service')>(
    '../../file-handling/upload.service',
  );
  return {
    ...actual,
    getUploadService: () => ({
      generateUploadUrl: vi.fn(),
      initiateChunkedUpload: vi.fn(),
      completeChunkedUpload: vi.fn(),
      getSession: vi.fn(),
      getTenantQuota: vi.fn(),
      updateSessionStatus: vi.fn(),
      getFileMetadata: vi.fn(),
      deleteFile: vi.fn(),
      generateDownloadUrl: vi.fn(),
    }),
  };
});

vi.mock('../../file-handling/virus-scan.service', () => ({
  getVirusScanService: () => ({ scanFile: vi.fn() }),
}));

vi.mock('../../file-handling/thumbnail.service', () => ({
  getThumbnailService: () => ({
    shouldGenerateThumbnail: () => false,
    generateThumbnail: vi.fn(),
  }),
}));

vi.mock('../../file-handling/validation.service', () => ({
  getValidationService: () => ({
    isAllowedMimeType: (mime: string) => mime === 'image/png',
  }),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn(),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { uploadRouter, uploadErrorAdapter } from '../../file-handling/upload.controller';
import {
  FileValidationError,
  QuotaExceededError,
} from '../../file-handling/upload.service';
import { errorHandler, ApiError } from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(uploadRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// 1. Success envelope
// ────────────────────────────────────────────────────────────────────────────

describe('uploadRouter — success envelope', () => {
  it('POST /webhook/scan-complete with valid secret emits { success: true, data: { ok: true } }', async () => {
    process.env.UPLOAD_WEBHOOK_SECRET = 'test-secret';
    const app = makeApp();

    const res = await request(app)
      .post('/webhook/scan-complete')
      .set('x-webhook-secret', 'test-secret')
      .send({ sessionId: 's1', fileKey: 'k1', clean: true, threats: [] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { ok: true },
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Validation error envelope (express-validator → ValidationError)
// ────────────────────────────────────────────────────────────────────────────

describe('uploadRouter — validation error envelope', () => {
  it('POST /presigned-url with missing body emits 422 / VALIDATION_ERROR with fieldErrors', async () => {
    const app = makeApp();

    // Empty body → every required express-validator check fails →
    // `handleValidationErrors` throws ValidationError.
    const res = await request(app).post('/presigned-url').send({});

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: { fieldErrors: expect.any(Array) },
      },
      meta: {
        path: '/presigned-url',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      },
    });
    // The fieldErrors array should carry the express-validator output (at
    // least one entry).
    expect(res.body.error.details.fieldErrors.length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3-5. uploadErrorAdapter branch coverage
// ────────────────────────────────────────────────────────────────────────────

describe('uploadErrorAdapter', () => {
  const req = {} as Request;
  const res = {} as Response;

  it('converts multer.MulterError to ApiError(400, err.code)', () => {
    const next = vi.fn();
    const multerErr = new multer.MulterError('LIMIT_FILE_SIZE');
    uploadErrorAdapter(multerErr, req, res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const passed = next.mock.calls[0][0] as ApiError;
    expect(passed).toBeInstanceOf(ApiError);
    expect(passed.statusCode).toBe(400);
    expect(passed.code).toBe('LIMIT_FILE_SIZE');
    expect(passed.message).toBe(multerErr.message);
  });

  it('converts FileValidationError to ApiError(400, FILE_VALIDATION_FAILED)', () => {
    const next = vi.fn();
    const err = new FileValidationError('Bad file type');
    uploadErrorAdapter(err, req, res, next as NextFunction);

    const passed = next.mock.calls[0][0] as ApiError;
    expect(passed).toBeInstanceOf(ApiError);
    expect(passed.statusCode).toBe(400);
    expect(passed.code).toBe('FILE_VALIDATION_FAILED');
    expect(passed.message).toBe('Bad file type');
  });

  it('converts QuotaExceededError to ApiError(429, QUOTA_EXCEEDED)', () => {
    const next = vi.fn();
    const err = new QuotaExceededError('Out of quota');
    uploadErrorAdapter(err, req, res, next as NextFunction);

    const passed = next.mock.calls[0][0] as ApiError;
    expect(passed).toBeInstanceOf(ApiError);
    expect(passed.statusCode).toBe(429);
    expect(passed.code).toBe('QUOTA_EXCEEDED');
    expect(passed.message).toBe('Out of quota');
  });

  it('passes through unknown errors untouched', () => {
    const next = vi.fn();
    const err = new Error('something else');
    uploadErrorAdapter(err, req, res, next as NextFunction);

    expect(next).toHaveBeenCalledWith(err);
  });
});
