/**
 * Wire tests for `POST /files/:sessionId/upload-complete` — the client-driven
 * virus-scan trigger.
 *
 * Pins the security-critical contract:
 *   - Tenant scoping: caller's tenant must match the file's tenant; super-admin
 *     context-switch via `req.tenantId` IS honored.
 *   - UUID validation on the path param.
 *   - File-existence check before scan (clear 404 if client never PUT to S3).
 *   - Idempotency: a session already in a terminal state (ready/quarantined)
 *     returns the cached result without re-scanning.
 *   - Clean scan → status='ready', scanResult returned.
 *   - Infected scan → status='quarantined', file deleted from S3, audit emits
 *     FILE_QUARANTINED.
 *   - Scanner error → 500 envelope (so the portal can show "scan failed,
 *     please retry" rather than silently mark the file ready).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  logAuditMock,
  getSessionMock,
  updateSessionStatusMock,
  fileExistsMock,
  deleteFileMock,
  scanFileMock,
  shouldGenerateThumbnailMock,
  generateThumbnailMock,
} = vi.hoisted(() => ({
  logAuditMock: vi.fn().mockResolvedValue(undefined),
  getSessionMock: vi.fn(),
  updateSessionStatusMock: vi.fn(),
  fileExistsMock: vi.fn(),
  deleteFileMock: vi.fn().mockResolvedValue(undefined),
  scanFileMock: vi.fn(),
  shouldGenerateThumbnailMock: vi.fn().mockReturnValue(false),
  generateThumbnailMock: vi.fn().mockResolvedValue('thumb-url'),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: logAuditMock,
}));

vi.mock('../../file-handling/upload.service', () => ({
  getUploadService: () => ({
    getSession: getSessionMock,
    updateSessionStatus: updateSessionStatusMock,
    fileExists: fileExistsMock,
    deleteFile: deleteFileMock,
    generateUploadUrl: vi.fn(),
    generatePublicUrl: vi.fn(),
    generateDownloadUrl: vi.fn(),
  }),
}));

vi.mock('../../file-handling/virus-scan.service', () => ({
  getVirusScanService: () => ({ scanFile: scanFileMock }),
}));

vi.mock('../../file-handling/thumbnail.service', () => ({
  getThumbnailService: () => ({
    shouldGenerateThumbnail: shouldGenerateThumbnailMock,
    generateThumbnail: generateThumbnailMock,
  }),
}));

vi.mock('../../billing/enforce', () => ({
  requireFeature: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  autoProvision: (req: any, _res: unknown, next: () => void) => {
    req.userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    req.tenantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    req.user = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      email: 'agent@x.test',
      role: 'agent',
      tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      type: 'agent',
    };
    next();
  },
}));

vi.mock('../../middleware/super-admin.middleware', () => ({
  resolveTenantContext: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import filesRoutes from '../../routes/files.routes';
import { errorHandler } from '../../middleware/error-handler';
import { requestIdMiddleware } from '../../middleware/request-id.middleware';

const FILE_SESSION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CALLER_TENANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // matches autoProvision mock
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const FILE_KEY = 'uploads/ccccc/2026/05/20/hash.pdf';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/files', filesRoutes);
  app.use(errorHandler);
  return app;
}

const cleanScanResult = {
  clean: true,
  threats: [],
  scannedAt: new Date('2026-05-20T12:00:00Z'),
  scanDurationMs: 42,
  fileKey: FILE_KEY,
  scanMethod: 'buffer' as const,
};

const infectedScanResult = {
  clean: false,
  threats: ['EICAR-Test-Signature'],
  scannedAt: new Date('2026-05-20T12:00:00Z'),
  scanDurationMs: 99,
  fileKey: FILE_KEY,
  scanMethod: 'buffer' as const,
};

beforeEach(() => {
  logAuditMock.mockClear();
  getSessionMock.mockReset();
  updateSessionStatusMock.mockReset();
  fileExistsMock.mockReset();
  deleteFileMock.mockClear();
  scanFileMock.mockReset();
  shouldGenerateThumbnailMock.mockClear();
  generateThumbnailMock.mockClear();
  process.env.AWS_ACCESS_KEY_ID = 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  process.env.AWS_S3_BUCKET = 'test-bucket';
});

// ─── UUID validation ───────────────────────────────────────────────────────

describe('POST /files/:sessionId/upload-complete — validation', () => {
  it('rejects non-UUID sessionId with 400 before reaching the service', async () => {
    const res = await request(makeApp()).post('/files/not-a-uuid/upload-complete');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toBe('Invalid sessionId');
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(scanFileMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the upload session does not exist', async () => {
    getSessionMock.mockReturnValue(undefined);

    const res = await request(makeApp()).post(`/files/${FILE_SESSION_ID}/upload-complete`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Upload session not found');
    expect(scanFileMock).not.toHaveBeenCalled();
  });
});

// ─── Tenant scoping ────────────────────────────────────────────────────────

describe('POST /files/:sessionId/upload-complete — tenant scoping', () => {
  it('returns 404 (SAME as missing — no cross-tenant oracle) when the file belongs to a different tenant', async () => {
    getSessionMock.mockReturnValue({
      sessionId: FILE_SESSION_ID,
      fileKey: FILE_KEY,
      status: 'pending',
      tenantId: OTHER_TENANT, // different from caller's CALLER_TENANT
      userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      mimeType: 'application/pdf',
    });

    const res = await request(makeApp()).post(`/files/${FILE_SESSION_ID}/upload-complete`);

    // Indistinguishable from a nonexistent session so a visitor can't probe
    // upload-session ids across tenants/chats.
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Upload session not found');
    expect(scanFileMock).not.toHaveBeenCalled();
    expect(fileExistsMock).not.toHaveBeenCalled();
  });
});

// ─── File-existence check ──────────────────────────────────────────────────

describe('POST /files/:sessionId/upload-complete — file existence', () => {
  it('returns 404 when the client has not yet uploaded to S3', async () => {
    getSessionMock.mockReturnValue({
      sessionId: FILE_SESSION_ID,
      fileKey: FILE_KEY,
      status: 'pending',
      tenantId: CALLER_TENANT,
      userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      mimeType: 'application/pdf',
    });
    fileExistsMock.mockResolvedValue(false);

    const res = await request(makeApp()).post(`/files/${FILE_SESSION_ID}/upload-complete`);

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('File not yet uploaded to S3');
    expect(scanFileMock).not.toHaveBeenCalled();
  });
});

// ─── Idempotency ───────────────────────────────────────────────────────────

describe('POST /files/:sessionId/upload-complete — idempotency', () => {
  it('returns cached result when session is already ready (no re-scan)', async () => {
    getSessionMock.mockReturnValue({
      sessionId: FILE_SESSION_ID,
      fileKey: FILE_KEY,
      status: 'ready',
      tenantId: CALLER_TENANT,
      userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      mimeType: 'application/pdf',
      scanResult: cleanScanResult,
    });

    const res = await request(makeApp()).post(`/files/${FILE_SESSION_ID}/upload-complete`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready');
    expect(res.body.data.scanResult.clean).toBe(true);
    // No scan or file-exists call.
    expect(scanFileMock).not.toHaveBeenCalled();
    expect(fileExistsMock).not.toHaveBeenCalled();
    // No new audit emitted.
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it('returns cached result when session is already quarantined (no re-scan)', async () => {
    getSessionMock.mockReturnValue({
      sessionId: FILE_SESSION_ID,
      fileKey: FILE_KEY,
      status: 'quarantined',
      tenantId: CALLER_TENANT,
      userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      mimeType: 'application/pdf',
      scanResult: infectedScanResult,
    });

    const res = await request(makeApp()).post(`/files/${FILE_SESSION_ID}/upload-complete`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('quarantined');
    expect(res.body.data.scanResult.threats).toEqual(['EICAR-Test-Signature']);
    expect(scanFileMock).not.toHaveBeenCalled();
  });
});

// ─── Clean scan happy path ─────────────────────────────────────────────────

describe('POST /files/:sessionId/upload-complete — clean scan', () => {
  it('promotes session to ready, emits FILE_SCAN_COMPLETED, returns scanResult', async () => {
    getSessionMock.mockReturnValue({
      sessionId: FILE_SESSION_ID,
      fileKey: FILE_KEY,
      status: 'pending',
      tenantId: CALLER_TENANT,
      userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      mimeType: 'application/pdf',
    });
    fileExistsMock.mockResolvedValue(true);
    scanFileMock.mockResolvedValue(cleanScanResult);

    const res = await request(makeApp()).post(`/files/${FILE_SESSION_ID}/upload-complete`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready');
    expect(res.body.data.scanResult.clean).toBe(true);
    expect(res.body.data.scanResult.scanMethod).toBe('buffer');

    // updateSessionStatus called twice: 'scanning' then 'ready'.
    expect(updateSessionStatusMock).toHaveBeenCalledWith(FILE_SESSION_ID, 'scanning');
    expect(updateSessionStatusMock).toHaveBeenCalledWith(FILE_SESSION_ID, 'ready', cleanScanResult);

    // Audit fired with the correct shape.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const [actorId, action, entityType, entityId, tenantId, meta] = logAuditMock.mock.calls[0];
    expect(actorId).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'); // session.userId
    expect(action).toBe('FILE_SCAN_COMPLETED');
    expect(entityType).toBe('upload');
    expect(entityId).toBe(FILE_SESSION_ID);
    expect(tenantId).toBe(CALLER_TENANT);
    expect(meta).toMatchObject({
      fileKey: FILE_KEY,
      clean: true,
      scanMethod: 'buffer',
      durationMs: 42,
    });

    // File NOT deleted.
    expect(deleteFileMock).not.toHaveBeenCalled();
  });
});

// ─── Infected scan ─────────────────────────────────────────────────────────

describe('POST /files/:sessionId/upload-complete — infected scan', () => {
  it('quarantines session, deletes file, emits FILE_QUARANTINED audit', async () => {
    getSessionMock.mockReturnValue({
      sessionId: FILE_SESSION_ID,
      fileKey: FILE_KEY,
      status: 'pending',
      tenantId: CALLER_TENANT,
      userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      mimeType: 'application/pdf',
    });
    fileExistsMock.mockResolvedValue(true);
    scanFileMock.mockResolvedValue(infectedScanResult);

    const res = await request(makeApp()).post(`/files/${FILE_SESSION_ID}/upload-complete`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('quarantined');
    expect(res.body.data.scanResult.threats).toEqual(['EICAR-Test-Signature']);

    expect(updateSessionStatusMock).toHaveBeenCalledWith(FILE_SESSION_ID, 'quarantined', infectedScanResult);

    // FILE_QUARANTINED audit.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const [actorId, action, _entityType, _entityId, _tenantId, meta] = logAuditMock.mock.calls[0];
    expect(actorId).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    expect(action).toBe('FILE_QUARANTINED');
    expect(meta).toMatchObject({
      fileKey: FILE_KEY,
      threats: ['EICAR-Test-Signature'],
      severity: 'HIGH',
    });

    // Infected file MUST be deleted from S3.
    expect(deleteFileMock).toHaveBeenCalledWith(FILE_KEY);
  });
});

// ─── Scanner error ─────────────────────────────────────────────────────────

describe('POST /files/:sessionId/upload-complete — scanner error', () => {
  it('marks session failed, surfaces 500 envelope (does NOT silently mark ready)', async () => {
    getSessionMock.mockReturnValue({
      sessionId: FILE_SESSION_ID,
      fileKey: FILE_KEY,
      status: 'pending',
      tenantId: CALLER_TENANT,
      userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      mimeType: 'application/pdf',
    });
    fileExistsMock.mockResolvedValue(true);
    scanFileMock.mockRejectedValue(new Error('ClamAV connection refused'));

    const res = await request(makeApp()).post(`/files/${FILE_SESSION_ID}/upload-complete`);

    expect(res.status).toBe(500);
    // Production: message redacted to the canned copy.
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(updateSessionStatusMock).toHaveBeenCalledWith(FILE_SESSION_ID, 'failed');
    // No audit emitted on failure — operator sees Sentry capture instead.
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});
