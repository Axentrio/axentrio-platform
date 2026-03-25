/**
 * Upload Controller - HTTP Endpoints for File Upload
 * White-label Chatbot Platform
 * 
 * Features:
 * - Pre-signed URL generation endpoints
 * - Chunked upload management
 * - Upload status tracking
 * - Webhook callbacks for virus scan completion
 * - Rate limiting and authentication
 */

import { Request, Response, NextFunction, Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { authenticateAgent as authenticateJWT } from '../security/auth.middleware';
const requireTenantAccess = authenticateJWT; // alias
import { auditLogger } from '../security/audit.logger';
import {
  getUploadService,
  UploadRequest,
  FileValidationError,
  QuotaExceededError,
} from './upload.service';
import { getVirusScanService } from './virus-scan.service';
import { getThumbnailService } from './thumbnail.service';
import { getValidationService } from './validation.service';

// ============================================================================
// Router Setup
// ============================================================================

const router = Router();

// Initialize services
const uploadService = getUploadService();
const virusScanService = getVirusScanService();
const thumbnailService = getThumbnailService();
const validationService = getValidationService();

// ============================================================================
// Rate Limiters
// ============================================================================

const uploadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 uploads per window
  message: {
    error: 'Rate limit exceeded',
    retryAfter: '15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    // Rate limit by tenant + user
    return `${req.tenantId}:${req.userId}`;
  },
});

const statusCheckLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 status checks per minute
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================================
// Validation Middleware
// ============================================================================

const handleValidationErrors = (req: Request, res: Response, next: NextFunction): any => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array(),
    });
  }
  next();
};

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /api/v1/uploads/presigned-url
 * Generate a pre-signed URL for direct S3 upload
 */
router.post(
  '/presigned-url',
  authenticateJWT,
  requireTenantAccess,
  uploadRateLimiter,
  [
    body('fileName')
      .trim()
      .notEmpty()
      .withMessage('fileName is required')
      .isLength({ max: 255 })
      .withMessage('fileName must be less than 255 characters'),
    body('fileSize')
      .isInt({ min: 1, max: 25 * 1024 * 1024 })
      .withMessage('fileSize must be between 1 and 25MB'),
    body('mimeType')
      .notEmpty()
      .withMessage('mimeType is required')
      .custom((value) => {
        if (!validationService.isAllowedMimeType(value)) {
          throw new Error(`MIME type ${value} is not allowed`);
        }
        return true;
      }),
    body('chatSessionId')
      .notEmpty()
      .withMessage('chatSessionId is required')
      .isUUID()
      .withMessage('chatSessionId must be a valid UUID'),
    handleValidationErrors,
  ],
  async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { fileName, fileSize, mimeType, chatSessionId, metadata } = req.body;
      const tenantId = req.tenantId!;
      const userId = req.userId!;

      // Log upload attempt
      auditLogger.log({
        action: 'UPLOAD_URL_REQUESTED',
        tenantId,
        userId,
        resource: 'upload',
        details: { fileName, fileSize, mimeType },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const uploadRequest: UploadRequest = {
        fileName,
        fileSize,
        mimeType,
        tenantId,
        userId,
        chatSessionId,
        metadata,
      };

      const session = await uploadService.generateUploadUrl(uploadRequest);

      // Schedule virus scan after upload
      setTimeout(async () => {
        try {
          await performVirusScan(session.sessionId, session.fileKey);
        } catch (error) {
          console.error('Virus scan scheduling error:', error);
        }
      }, 5000); // Check after 5 seconds

      res.status(200).json({
        success: true,
        data: {
          sessionId: session.sessionId,
          uploadUrl: session.uploadUrl,
          publicUrl: session.publicUrl,
          expiresAt: session.expiresAt,
          fileKey: session.fileKey,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/uploads/chunked/init
 * Initialize a chunked upload session
 */
router.post(
  '/chunked/init',
  authenticateJWT,
  requireTenantAccess,
  uploadRateLimiter,
  [
    body('fileName').trim().notEmpty().withMessage('fileName is required'),
    body('fileSize')
      .isInt({ min: 1, max: 100 * 1024 * 1024 })
      .withMessage('fileSize must be between 1 and 100MB'),
    body('mimeType').notEmpty().withMessage('mimeType is required'),
    body('chatSessionId').isUUID().withMessage('chatSessionId must be a valid UUID'),
    body('chunkSize')
      .optional()
      .isInt({ min: 1024 * 1024, max: 10 * 1024 * 1024 })
      .withMessage('chunkSize must be between 1MB and 10MB'),
    handleValidationErrors,
  ],
  async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { fileName, fileSize, mimeType, chatSessionId, chunkSize, metadata } = req.body;
      const tenantId = req.tenantId!;
      const userId = req.userId!;

      auditLogger.log({
        action: 'CHUNKED_UPLOAD_INITIATED',
        tenantId,
        userId,
        resource: 'upload',
        details: { fileName, fileSize, mimeType },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const uploadRequest: UploadRequest = {
        fileName,
        fileSize,
        mimeType,
        tenantId,
        userId,
        chatSessionId,
        metadata,
      };

      const { session, chunkUrls, uploadId } = await uploadService.initiateChunkedUpload(
        uploadRequest,
        chunkSize
      );

      res.status(200).json({
        success: true,
        data: {
          sessionId: session.sessionId,
          uploadId,
          chunkUrls,
          totalChunks: chunkUrls.length,
          chunkSize: chunkSize || 5 * 1024 * 1024,
          expiresAt: session.expiresAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/uploads/chunked/complete
 * Complete a chunked upload
 */
router.post(
  '/chunked/complete',
  authenticateJWT,
  requireTenantAccess,
  [
    body('sessionId').notEmpty().withMessage('sessionId is required'),
    body('parts')
      .isArray({ min: 1 })
      .withMessage('parts must be a non-empty array'),
    body('parts.*.ETag').notEmpty().withMessage('Each part must have an ETag'),
    body('parts.*.PartNumber')
      .isInt({ min: 1 })
      .withMessage('Each part must have a valid PartNumber'),
    handleValidationErrors,
  ],
  async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { sessionId, parts } = req.body;
      const tenantId = req.tenantId!;
      const userId = req.userId!;

      const session = await uploadService.completeChunkedUpload(sessionId, parts);

      // Trigger virus scan
      setTimeout(async () => {
        try {
          await performVirusScan(session.sessionId, session.fileKey);
        } catch (error) {
          console.error('Virus scan error:', error);
        }
      }, 1000);

      auditLogger.log({
        action: 'CHUNKED_UPLOAD_COMPLETED',
        tenantId,
        userId,
        resource: 'upload',
        details: { sessionId, fileKey: session.fileKey },
        ip: req.ip,
      });

      res.status(200).json({
        success: true,
        data: {
          sessionId: session.sessionId,
          status: session.status,
          publicUrl: session.publicUrl,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/uploads/status/:sessionId
 * Get upload status
 */
router.get(
  '/status/:sessionId',
  authenticateJWT,
  statusCheckLimiter,
  [param('sessionId').notEmpty().withMessage('sessionId is required'), handleValidationErrors],
  async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { sessionId } = req.params;
      const session = uploadService.getSession(sessionId);

      if (!session) {
        return res.status(404).json({
          error: 'Upload session not found',
        });
      }

      // Verify tenant access
      if (session.tenantId !== req.tenantId) {
        return res.status(403).json({
          error: 'Access denied',
        });
      }

      res.status(200).json({
        success: true,
        data: {
          sessionId: session.sessionId,
          status: session.status,
          fileKey: session.fileKey,
          publicUrl: session.status === 'ready' ? session.publicUrl : null,
          originalName: session.originalName,
          fileSize: session.fileSize,
          mimeType: session.mimeType,
          createdAt: session.createdAt,
          scanResult: session.scanResult,
          thumbnailUrl: session.thumbnailUrl,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/uploads/quota
 * Get tenant quota information
 */
router.get(
  '/quota',
  authenticateJWT,
  requireTenantAccess,
  async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
      const tenantId = req.tenantId!;
      const quota = uploadService.getTenantQuota(tenantId);

      res.status(200).json({
        success: true,
        data: {
          tenantId: quota.tenantId,
          maxStorageBytes: quota.maxStorageBytes,
          maxFilesPerMonth: quota.maxFilesPerMonth,
          currentStorageBytes: quota.currentStorageBytes,
          currentFilesThisMonth: quota.currentFilesThisMonth,
          storageUsedPercent: Math.round(
            (quota.currentStorageBytes / quota.maxStorageBytes) * 100
          ),
          filesUsedPercent: Math.round(
            (quota.currentFilesThisMonth / quota.maxFilesPerMonth) * 100
          ),
          lastResetDate: quota.lastResetDate,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/uploads/webhook/scan-complete
 * Webhook for virus scan completion (internal use)
 */
router.post(
  '/webhook/scan-complete',
  async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { sessionId, fileKey, clean, threats } = req.body;

      // Verify webhook secret
      const webhookSecret = req.headers['x-webhook-secret'];
      if (webhookSecret !== process.env.UPLOAD_WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Invalid webhook secret' });
      }

      const scanResult = {
        clean,
        threats: threats || [],
        scannedAt: new Date(),
      };

      const session = uploadService.updateSessionStatus(
        sessionId,
        clean ? 'ready' : 'quarantined',
        scanResult
      );

      if (session && clean) {
        // Generate thumbnail for images/videos
        if (thumbnailService.shouldGenerateThumbnail(session.mimeType)) {
          try {
            const thumbnailUrl = await thumbnailService.generateThumbnail(
              fileKey,
              session.mimeType
            );
            session.thumbnailUrl = thumbnailUrl;
          } catch (error) {
            console.error('Thumbnail generation error:', error);
          }
        }

        // Log successful scan
        auditLogger.log({
          action: 'FILE_SCAN_COMPLETED',
          tenantId: session.tenantId,
          userId: session.userId,
          resource: 'upload',
          details: {
            sessionId,
            fileKey,
            clean: true,
          },
        });
      } else if (session && !clean) {
        // Log quarantine
        auditLogger.log({
          action: 'FILE_QUARANTINED',
          tenantId: session.tenantId,
          userId: session.userId,
          resource: 'upload',
          severity: 'HIGH',
          details: {
            sessionId,
            fileKey,
            threats,
          },
        });

        // Delete infected file
        await uploadService.deleteFile(fileKey);
      }

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/uploads/:fileKey
 * Delete an uploaded file
 */
router.delete(
  '/:fileKey',
  authenticateJWT,
  requireTenantAccess,
  [param('fileKey').notEmpty().withMessage('fileKey is required'), handleValidationErrors],
  async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { fileKey } = req.params;
      const tenantId = req.tenantId!;
      const userId = req.userId!;

      // Verify file belongs to tenant
      const metadata = await uploadService.getFileMetadata(fileKey);
      if (!metadata || metadata['tenant-id'] !== tenantId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      await uploadService.deleteFile(fileKey);

      auditLogger.log({
        action: 'FILE_DELETED',
        tenantId,
        userId,
        resource: 'upload',
        details: { fileKey },
        ip: req.ip,
      });

      res.status(200).json({
        success: true,
        message: 'File deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/uploads/download/:fileKey
 * Generate a temporary download URL
 */
router.get(
  '/download/:fileKey',
  authenticateJWT,
  requireTenantAccess,
  async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { fileKey } = req.params;
      const { filename } = req.query;
      const tenantId = req.tenantId!;

      // Verify file belongs to tenant
      const metadata = await uploadService.getFileMetadata(fileKey);
      if (!metadata || metadata['tenant-id'] !== tenantId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const downloadUrl = await uploadService.generateDownloadUrl(
        fileKey,
        filename as string | undefined,
        300 // 5 minutes
      );

      auditLogger.log({
        action: 'FILE_DOWNLOAD_REQUESTED',
        tenantId,
        userId: req.userId!,
        resource: 'upload',
        details: { fileKey },
        ip: req.ip,
      });

      res.status(200).json({
        success: true,
        data: {
          downloadUrl,
          expiresIn: 300,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================================
// Helper Functions
// ============================================================================

async function performVirusScan(sessionId: string, fileKey: string): Promise<void> {
  try {
    const session = uploadService.getSession(sessionId);
    if (!session) return;

    // Update status to scanning
    uploadService.updateSessionStatus(sessionId, 'scanning');

    // Perform virus scan
    const scanResult = await virusScanService.scanFile(fileKey);

    // Update session with scan result
    uploadService.updateSessionStatus(
      sessionId,
      scanResult.clean ? 'ready' : 'quarantined',
      scanResult
    );

    if (scanResult.clean) {
      // Generate thumbnail if applicable
      if (thumbnailService.shouldGenerateThumbnail(session.mimeType)) {
        try {
          const thumbnailUrl = await thumbnailService.generateThumbnail(
            fileKey,
            session.mimeType
          );
          session.thumbnailUrl = thumbnailUrl;
        } catch (error) {
          console.error('Thumbnail generation error:', error);
        }
      }
    } else {
      // Delete infected file
      await uploadService.deleteFile(fileKey);
    }
  } catch (error) {
    console.error('Virus scan error:', error);
    uploadService.updateSessionStatus(sessionId, 'failed');
  }
}

// ============================================================================
// Error Handler
// ============================================================================

router.use((error: Error, req: Request, res: Response, _next: NextFunction): any => {
  console.error('Upload controller error:', error);

  if (error instanceof FileValidationError) {
    return res.status(400).json({
      error: 'File validation failed',
      message: error.message,
    });
  }

  if (error instanceof QuotaExceededError) {
    return res.status(429).json({
      error: 'Quota exceeded',
      message: error.message,
    });
  }

  // Log unexpected errors
  auditLogger.log({
    action: 'UPLOAD_ERROR',
    tenantId: req.tenantId || 'unknown',
    userId: req.userId || 'unknown',
    resource: 'upload',
    severity: 'HIGH',
    details: {
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    },
    ip: req.ip,
  });

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
  });
});

// ============================================================================
// Exports
// ============================================================================

export default router;
export { router as uploadRouter };
