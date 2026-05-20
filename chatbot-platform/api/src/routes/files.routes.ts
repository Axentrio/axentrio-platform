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

    const session = uploadService.getSession(id);
    if (!session) {
      throw new NotFoundError('File not found');
    }

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
    const authReq = req as ProvisionedRequest;
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

    const session = uploadService.getSession(id);
    if (!session) {
      throw new NotFoundError('File not found');
    }

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
    const authReq = req as ProvisionedRequest;
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

export default router;
