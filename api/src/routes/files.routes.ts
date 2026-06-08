/**
 * File Routes
 * Upload, preview, and download endpoints
 */
import { Router, Request, Response } from 'express';
import { asyncHandler, ApiError, BadRequestError, NotFoundError } from '../middleware/error-handler';
import { ERROR_CODES } from '../middleware/error-codes';
import { sendSuccess } from '../utils/response';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireFeature } from '../billing/enforce';
import { logAudit } from '../utils/audit';

const router = Router();

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

// `AuditLog.entityId` is a NOT-NULL UUID column. Validate any caller-supplied
// id (request body / route params) before passing it to `logAudit` so the
// row is queryable and the insert doesn't silently fail in audit's catch.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Check if S3/upload service is configured
 */
function isS3Configured(): boolean {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET);
}

/**
 * Tenant + readiness gate for the file read endpoints (preview/download).
 *
 * A signed URL may only be minted for a file owned by the caller's EFFECTIVE
 * tenant (`authReq.tenantId` — set by autoProvision, switched by
 * resolveTenantContext for super-admins) and only once virus scanning has
 * cleared it to `ready`. Foreign-tenant and not-yet-ready files throw the SAME
 * 404 as a missing file, so a caller cannot use these endpoints as a
 * cross-tenant existence oracle for file ids.
 */
function assertReadableFile(
  session: { tenantId: string; status: string },
  authReq: ProvisionedRequest,
): void {
  if (session.tenantId !== authReq.tenantId || session.status !== 'ready') {
    throw new NotFoundError('File not found');
  }
}

/**
 * POST /files/upload
 * Upload a file (multipart)
 */
router.post(
  '/upload',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    if (!isS3Configured()) {
      throw new ApiError(
        'File upload service is not configured. S3 credentials are required.',
        503,
        ERROR_CODES.FILE_SERVICE_UNAVAILABLE
      );
    }

    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) {
      throw new BadRequestError('Tenant context required');
    }
    // Plan-gate (step 10, feature 5). Throws 402 plan_limit_file_upload when
    // the tenant's tier doesn't include file upload (currently Free).
    await requireFeature(tenantId, 'fileUpload', 'plan_limit_file_upload');

    const { getUploadService } = await import('../file-handling/upload.service');
    const uploadService = getUploadService();

    const { fileName, fileSize, mimeType, sessionId } = req.body;

    if (!fileName || !fileSize || !mimeType) {
      throw new BadRequestError('fileName, fileSize, and mimeType are required');
    }

    const uploadSession = await uploadService.generateUploadUrl({
      fileName,
      fileSize,
      mimeType,
      tenantId,
      userId: authReq.user?.id || '',
      chatSessionId: sessionId || '',
    });

    sendSuccess(res, {
      upload: {
        sessionId: uploadSession.sessionId,
        uploadUrl: uploadSession.uploadUrl,
        publicUrl: uploadSession.publicUrl,
        expiresAt: uploadSession.expiresAt,
      },
    });

    // Audit AFTER `generateUploadUrl` because the service-generated
    // `uploadSession.sessionId` is the only id guaranteed to be a UUID — the
    // chatSessionId from the request body is unvalidated. Divergence from
    // upload.controller.ts (which audits BEFORE) — that controller has
    // express-validator's `isUUID()` on chatSessionId; we don't. Trade-off:
    // a `generateUploadUrl` failure leaves no audit row, but the global
    // errorHandler + Sentry still capture the exception path.
    // actorId is `req.userId` (User entity id), NOT `req.user.id` (which is
    // the agent id alias for backward-compat — see clerk.middleware.ts:381).
    logAudit(
      authReq.userId!,
      'UPLOAD_URL_REQUESTED',
      'upload',
      uploadSession.sessionId,
      tenantId,
      {
        fileName,
        fileSize,
        mimeType,
        chatSessionId: isUuid(sessionId) ? sessionId : undefined,
        ip: req.ip,
      },
    );
  })
);

/**
 * GET /files/:id/preview
 * Get a signed URL for file preview
 */
router.get(
  '/:id/preview',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    if (!isS3Configured()) {
      throw new ApiError(
        'File service is not configured',
        503,
        ERROR_CODES.FILE_SERVICE_UNAVAILABLE
      );
    }

    const { getUploadService } = await import('../file-handling/upload.service');
    const uploadService = getUploadService();
    const { id } = req.params;

    // Validate before passing to logAudit (entity_id is NOT-NULL UUID).
    if (!isUuid(id)) {
      throw new BadRequestError('Invalid file id');
    }

    const authReq = req as ProvisionedRequest;
    const session = await uploadService.getSession(id);
    if (!session) {
      throw new NotFoundError('File not found');
    }
    assertReadableFile(session, authReq);

    const previewUrl = await uploadService.generatePublicUrl(session.fileKey, 3600);

    sendSuccess(res, {
      previewUrl,
      fileName: session.originalName,
      mimeType: session.mimeType,
    });

    // tenantId comes from `session.tenantId` (the file's owner tenant), NOT
    // the actor's `req.user.tenantId` — `resolveTenantContext` lets super-admins
    // operate on other tenants, so the actor's home tenant can differ from
    // the file's. Using the file's tenant keeps tenant-scoped audit queries
    // accurate.
    logAudit(
      authReq.userId!,
      'FILE_PREVIEW_REQUESTED',
      'upload',
      id,
      session.tenantId,
      {
        fileName: session.originalName,
        mimeType: session.mimeType,
        fileKey: session.fileKey,
        ip: req.ip,
      },
    );
  })
);

/**
 * GET /files/:id/download
 * Get a signed URL for file download
 */
router.get(
  '/:id/download',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    if (!isS3Configured()) {
      throw new ApiError(
        'File service is not configured',
        503,
        ERROR_CODES.FILE_SERVICE_UNAVAILABLE
      );
    }

    const { getUploadService } = await import('../file-handling/upload.service');
    const uploadService = getUploadService();
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new BadRequestError('Invalid file id');
    }

    const authReq = req as ProvisionedRequest;
    const session = await uploadService.getSession(id);
    if (!session) {
      throw new NotFoundError('File not found');
    }
    assertReadableFile(session, authReq);

    const downloadUrl = await uploadService.generateDownloadUrl(
      session.fileKey,
      session.originalName,
      300
    );

    sendSuccess(res, {
      downloadUrl,
      fileName: session.originalName,
      fileSize: session.fileSize,
    });

    // upload.controller.ts:520 logs entityId = fileKey, but `fileKey` is an
    // S3 path string (`uploads/<tenant>/<yyyy>/<mm>/<dd>/<hash>.<ext>`) — not
    // a UUID — so that insert would actually fail the audit schema (the
    // unmounted route has never had its audit calls exercised). Here we use
    // the file session id as entityId (UUID by construction) and put fileKey
    // in metadata for cross-queryability. Same shape as the preview audit.
    logAudit(
      authReq.userId!,
      'FILE_DOWNLOAD_REQUESTED',
      'upload',
      id,
      session.tenantId,
      {
        fileName: session.originalName,
        fileSize: session.fileSize,
        fileKey: session.fileKey,
        ip: req.ip,
      },
    );
  })
);

/**
 * POST /files/:sessionId/upload-complete
 *
 * Client-driven scan trigger. The portal calls this AFTER the S3 PUT
 * (presigned URL from POST /upload) completes — the API then:
 *   1. Verifies the file actually landed in S3.
 *   2. Calls the shared `performScan` helper (virus scan → status update →
 *      audit log → thumbnail-if-clean / delete-if-infected).
 *   3. Returns the scan result so the portal can show a clear UX:
 *      `ready` → display/download enabled; `quarantined` → file removed,
 *      show error toast.
 *
 * Idempotent: if the session is already in a terminal state (`ready` /
 * `quarantined`), returns the cached result without re-scanning.
 *
 * Tenant-scoped: caller's effective tenant must match the file's tenant.
 * Super-admin context-switch is honored via `req.tenantId`
 * (resolveTenantContext) — see clerk.middleware.ts:381.
 */
router.post(
  '/:sessionId/upload-complete',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    if (!isS3Configured()) {
      throw new ApiError(
        'File service is not configured',
        503,
        ERROR_CODES.FILE_SERVICE_UNAVAILABLE,
      );
    }

    const { sessionId } = req.params;
    if (!isUuid(sessionId)) {
      throw new BadRequestError('Invalid sessionId');
    }

    const { getUploadService } = await import('../file-handling/upload.service');
    const uploadService = getUploadService();

    // Tenant scoping. `req.tenantId` honors `resolveTenantContext` (so
    // super-admins can complete uploads in a tenant they've switched into).
    // For non-super-admins it equals their home tenant. A missing session AND
    // a foreign-tenant session both throw the SAME 404 so the endpoint isn't a
    // cross-tenant existence oracle for upload-session ids.
    const authReq = req as ProvisionedRequest;
    const callerTenantId = authReq.tenantId ?? authReq.user?.tenantId;
    const session = await uploadService.getSession(sessionId);
    if (!session || session.tenantId !== callerTenantId) {
      throw new NotFoundError('Upload session not found');
    }

    // Idempotency: if the session already reached a terminal state, return
    // the cached result. Avoids re-scanning on portal retries / page
    // refreshes and keeps the audit log clean (no duplicate scan-completed
    // entries).
    if (session.status === 'ready' || session.status === 'quarantined') {
      sendSuccess(res, {
        sessionId,
        status: session.status,
        scanResult: session.scanResult ?? null,
      });
      return;
    }

    // Verify the client actually uploaded. The presigned URL from
    // POST /upload could be unused (client gave up, network failed). In
    // that case `scanFile` would 404 against S3; check up front so the
    // error message is clear.
    const fileExists = await uploadService.fileExists(session.fileKey);
    if (!fileExists) {
      throw new NotFoundError('File not yet uploaded to S3');
    }

    // Awaited scan. Throws on scanner / S3 errors → reaches global error
    // handler as 500 / INTERNAL_ERROR. On success, returns the canonical
    // ScanResult. The shared trigger already emitted the audit log
    // (FILE_SCAN_COMPLETED / FILE_QUARANTINED), updated the session
    // status, and (if quarantined) deleted the infected file from S3.
    const { performScan } = await import('../file-handling/virus-scan-trigger');
    const scanResult = await performScan(sessionId, session.fileKey);

    sendSuccess(res, {
      sessionId,
      status: scanResult.clean ? 'ready' : 'quarantined',
      scanResult,
    });
  }),
);

export default router;
