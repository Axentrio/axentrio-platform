/**
 * File Routes
 * Upload, preview, and download endpoints
 */
import { Router, Request, Response } from 'express';
import { asyncHandler, BadRequestError, NotFoundError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';

const router = Router();

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

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
      res.status(503).json({
        error: 'File upload service is not configured. S3 credentials are required.',
      });
      return;
    }

    const authReq = req as ProvisionedRequest;
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
      tenantId: authReq.user?.tenantId || '',
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
      res.status(503).json({ error: 'File service is not configured' });
      return;
    }

    const { getUploadService } = await import('../file-handling/upload.service');
    const uploadService = getUploadService();
    const { id } = req.params;

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
      res.status(503).json({ error: 'File service is not configured' });
      return;
    }

    const { getUploadService } = await import('../file-handling/upload.service');
    const uploadService = getUploadService();
    const { id } = req.params;

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
  })
);

export default router;
