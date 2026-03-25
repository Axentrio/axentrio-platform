/**
 * File Routes
 * Upload, preview, and download endpoints
 */
import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';

const router = Router();

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision);

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
  async (req: Request, res: Response): Promise<void> => {
    try {
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
        res.status(400).json({ error: 'fileName, fileSize, and mimeType are required' });
        return;
      }

      const uploadSession = await uploadService.generateUploadUrl({
        fileName,
        fileSize,
        mimeType,
        tenantId: authReq.user?.tenantId || '',
        userId: authReq.user?.id || '',
        chatSessionId: sessionId || '',
      });

      res.json({
        success: true,
        upload: {
          sessionId: uploadSession.sessionId,
          uploadUrl: uploadSession.uploadUrl,
          publicUrl: uploadSession.publicUrl,
          expiresAt: uploadSession.expiresAt,
        },
      });
    } catch (error: any) {
      if (error.name === 'FileValidationError' || error.name === 'QuotaExceededError') {
        res.status(400).json({ error: error.message });
        return;
      }
      logger.error('Error handling file upload:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /files/:id/preview
 * Get a signed URL for file preview
 */
router.get(
  '/:id/preview',
  async (req: Request, res: Response): Promise<void> => {
    try {
      if (!isS3Configured()) {
        res.status(503).json({ error: 'File service is not configured' });
        return;
      }

      const { getUploadService } = await import('../file-handling/upload.service');
      const uploadService = getUploadService();
      const { id } = req.params;

      const session = uploadService.getSession(id);
      if (!session) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const previewUrl = await uploadService.generatePublicUrl(session.fileKey, 3600);

      res.json({
        success: true,
        previewUrl,
        fileName: session.originalName,
        mimeType: session.mimeType,
      });
    } catch (error) {
      logger.error('Error generating preview URL:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /files/:id/download
 * Get a signed URL for file download
 */
router.get(
  '/:id/download',
  async (req: Request, res: Response): Promise<void> => {
    try {
      if (!isS3Configured()) {
        res.status(503).json({ error: 'File service is not configured' });
        return;
      }

      const { getUploadService } = await import('../file-handling/upload.service');
      const uploadService = getUploadService();
      const { id } = req.params;

      const session = uploadService.getSession(id);
      if (!session) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const downloadUrl = await uploadService.generateDownloadUrl(
        session.fileKey,
        session.originalName,
        300
      );

      res.json({
        success: true,
        downloadUrl,
        fileName: session.originalName,
        fileSize: session.fileSize,
      });
    } catch (error) {
      logger.error('Error generating download URL:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
