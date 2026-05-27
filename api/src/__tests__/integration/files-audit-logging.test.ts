/**
 * Integration coverage for the audit-logging additions on the mounted
 * file-upload path (`routes/files.routes.ts`).
 *
 * Before this commit the production upload path had ZERO `logAudit` calls
 * while the unmounted `file-handling/upload.controller.ts` had 11 — every
 * file uploaded by the portal was untraceable. These tests pin the new
 * `logAudit` call signatures so:
 *   - actorId is `req.userId` (User entity id), NOT `req.user.id` (agent
 *     alias) — codex round 2 #2.
 *   - entityId is always a UUID — codex round 2 #3 (audit_logs.entity_id is
 *     NOT-NULL UUID; non-UUID would silently fail the insert).
 *   - tenantId on preview/download is the FILE's tenant, NOT the actor's —
 *     codex round 2 #4 (resolveTenantContext can swap req.tenantId).
 *   - Per-handler metadata shape matches the upload.controller.ts conventions
 *     so audit queries work uniformly across both implementations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { logAuditMock, getSessionMock, generateUploadUrlMock, generatePublicUrlMock, generateDownloadUrlMock } = vi.hoisted(() => ({
  logAuditMock: vi.fn().mockResolvedValue(undefined),
  getSessionMock: vi.fn(),
  generateUploadUrlMock: vi.fn(),
  generatePublicUrlMock: vi.fn(),
  generateDownloadUrlMock: vi.fn(),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: logAuditMock,
}));

vi.mock('../../file-handling/upload.service', () => ({
  getUploadService: () => ({
    getSession: getSessionMock,
    generateUploadUrl: generateUploadUrlMock,
    generatePublicUrl: generatePublicUrlMock,
    generateDownloadUrl: generateDownloadUrlMock,
  }),
}));

vi.mock('../../billing/enforce', () => ({
  requireFeature: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  autoProvision: (req: any, _res: unknown, next: () => void) => {
    // Mirror what the real autoProvision attaches.
    req.userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // User entity id
    req.user = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', // Agent id (different on purpose)
      email: 'agent@x.test',
      role: 'agent',
      tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', // actor's home tenant
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
const CHAT_SESSION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FILE_TENANT_ID = '99999999-9999-4999-8999-999999999999'; // file's owner tenant (NOT the actor's)

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/files', filesRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  logAuditMock.mockClear();
  getSessionMock.mockReset();
  generateUploadUrlMock.mockReset();
  generatePublicUrlMock.mockReset();
  generateDownloadUrlMock.mockReset();

  // S3 env vars required for the routes' isS3Configured() check.
  process.env.AWS_ACCESS_KEY_ID = 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  process.env.AWS_S3_BUCKET = 'test-bucket';
});

// ─── POST /files/upload ────────────────────────────────────────────────────

describe('POST /files/upload audit', () => {
  it('fires logAudit with actorId=userId (NOT agent id) and entityId=uploadSession.sessionId', async () => {
    generateUploadUrlMock.mockResolvedValue({
      sessionId: FILE_SESSION_ID,
      uploadUrl: 'https://s3/upload',
      publicUrl: 'https://s3/public',
      expiresAt: '2026-01-01T00:00:00Z',
    });

    const res = await request(makeApp())
      .post('/files/upload')
      .send({ fileName: 'x.pdf', fileSize: 1024, mimeType: 'application/pdf', sessionId: CHAT_SESSION_ID });

    expect(res.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const [actorId, action, entityType, entityId, tenantId, meta] = logAuditMock.mock.calls[0];
    expect(actorId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); // user id, NOT agent id
    expect(action).toBe('UPLOAD_URL_REQUESTED');
    expect(entityType).toBe('upload');
    expect(entityId).toBe(FILE_SESSION_ID); // service-generated UUID
    expect(tenantId).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc'); // actor's tenant (only for upload — preview/download use file's)
    expect(meta).toMatchObject({
      fileName: 'x.pdf',
      fileSize: 1024,
      mimeType: 'application/pdf',
      chatSessionId: CHAT_SESSION_ID,
    });
  });

  it('drops a non-UUID chatSessionId from audit metadata (entity_id is a UUID column)', async () => {
    generateUploadUrlMock.mockResolvedValue({
      sessionId: FILE_SESSION_ID,
      uploadUrl: 'https://s3/upload',
      publicUrl: 'https://s3/public',
      expiresAt: '2026-01-01T00:00:00Z',
    });

    await request(makeApp())
      .post('/files/upload')
      .send({ fileName: 'x.pdf', fileSize: 1024, mimeType: 'application/pdf', sessionId: 'not-a-uuid' });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const meta = logAuditMock.mock.calls[0][5];
    expect(meta.chatSessionId).toBeUndefined();
  });

  it('does NOT audit when the upload request fails validation (no row written)', async () => {
    await request(makeApp())
      .post('/files/upload')
      .send({ fileName: 'x.pdf' }); // missing fileSize + mimeType

    expect(logAuditMock).not.toHaveBeenCalled();
  });
});

// ─── GET /files/:id/preview ────────────────────────────────────────────────

describe('GET /files/:id/preview audit', () => {
  it('audits with the FILE\'s tenantId (NOT the actor\'s) + fileKey in metadata', async () => {
    getSessionMock.mockReturnValue({
      sessionId: FILE_SESSION_ID,
      fileKey: 'uploads/99999/2026/01/15/hash.pdf',
      originalName: 'doc.pdf',
      mimeType: 'application/pdf',
      fileSize: 2048,
      tenantId: FILE_TENANT_ID, // different from actor's tenant
    });
    generatePublicUrlMock.mockResolvedValue('https://s3/preview-signed');

    const res = await request(makeApp()).get(`/files/${FILE_SESSION_ID}/preview`);

    expect(res.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const [actorId, action, entityType, entityId, tenantId, meta] = logAuditMock.mock.calls[0];
    expect(actorId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); // user id
    expect(action).toBe('FILE_PREVIEW_REQUESTED');
    expect(entityType).toBe('upload');
    expect(entityId).toBe(FILE_SESSION_ID);
    expect(tenantId).toBe(FILE_TENANT_ID); // FILE's tenant, NOT actor's (codex round 2 #4)
    expect(meta.fileKey).toBe('uploads/99999/2026/01/15/hash.pdf');
    expect(meta.fileName).toBe('doc.pdf');
  });

  it('rejects a non-UUID :id with 400 before reaching the upload service or audit', async () => {
    const res = await request(makeApp()).get('/files/not-a-uuid/preview');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toBe('Invalid file id');
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});

// ─── GET /files/:id/download ───────────────────────────────────────────────

describe('GET /files/:id/download audit', () => {
  it('audits FILE_DOWNLOAD_REQUESTED with fileKey in metadata + file\'s tenantId', async () => {
    getSessionMock.mockReturnValue({
      sessionId: FILE_SESSION_ID,
      fileKey: 'uploads/99999/2026/01/15/hash.pdf',
      originalName: 'doc.pdf',
      mimeType: 'application/pdf',
      fileSize: 4096,
      tenantId: FILE_TENANT_ID,
    });
    generateDownloadUrlMock.mockResolvedValue('https://s3/download-signed');

    const res = await request(makeApp()).get(`/files/${FILE_SESSION_ID}/download`);

    expect(res.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const [actorId, action, entityType, entityId, tenantId, meta] = logAuditMock.mock.calls[0];
    expect(actorId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(action).toBe('FILE_DOWNLOAD_REQUESTED');
    expect(entityType).toBe('upload');
    expect(entityId).toBe(FILE_SESSION_ID);
    expect(tenantId).toBe(FILE_TENANT_ID);
    expect(meta).toMatchObject({
      fileName: 'doc.pdf',
      fileSize: 4096,
      fileKey: 'uploads/99999/2026/01/15/hash.pdf',
    });
  });

  it('rejects a non-UUID :id with 400 before reaching the upload service or audit', async () => {
    const res = await request(makeApp()).get('/files/not-a-uuid/download');

    expect(res.status).toBe(400);
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});
