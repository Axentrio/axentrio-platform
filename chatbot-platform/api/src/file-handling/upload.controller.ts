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
import multer from 'multer';
import { authenticateAgent as authenticateJWT } from '../security/auth.middleware';
const requireTenantAccess = authenticateJWT; // alias
import { logAudit } from '../utils/audit';
import { logger } from '../utils/logger';
import { sendSuccess } from '../utils/response';
import {
  ApiError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '../middleware/error-handler';
import { ERROR_CODES } from '../middleware/error-codes';
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

const computeRetryAfter = (req: Request): number | undefined => {
  // express-rate-limit augments the request object with a `rateLimit` field
  // (configurable via `requestPropertyName`) that includes `resetTime`.
  // It does not extend the global Express `Request` type, so cast locally.
  const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } })
    .rateLimit?.resetTime;
  if (resetTime instanceof Date) {
    return Math.ceil((resetTime.getTime() - Date.now()) / 1000);
  }
  return undefined;
};

const uploadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 uploads per window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    // Rate limit by tenant + user
    return `${req.tenantId}:${req.userId}`;
  },
  handler: (req: Request, _res: Response, next: NextFunction) => {
    const retryAfter = computeRetryAfter(req);
    next(
      new RateLimitError(
        'Rate limit exceeded',
        retryAfter !== undefined ? { retryAfter } : undefined,
      ),
    );
  },
});

const statusCheckLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 status checks per minute
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, _res: Response, next: NextFunction) => {
    const retryAfter = computeRetryAfter(req);
    next(
      new RateLimitError(
        'Rate limit exceeded',
        retryAfter !== undefined ? { retryAfter } : undefined,
      ),
    );
  },
});

// ============================================================================
// Validation Middleware
// ============================================================================

const handleValidationErrors = (req: Request, _res: Response, next: NextFunction): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(
      new ValidationError('Validation failed', { fieldErrors: errors.array() }),
    );
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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { fileName, fileSize, mimeType, chatSessionId, metadata } = req.body;
      const tenantId = req.tenantId!;
      const userId = req.userId!;

      // Log upload attempt
      logAudit(userId, 'UPLOAD_URL_REQUESTED', 'upload', chatSessionId, tenantId, { fileName, fileSize, mimeType, ip: req.ip });

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

      // Virus scan with timeout protection (fire-and-forget)
      (async () => {
        try {
          const VIRUS_SCAN_TIMEOUT_MS = 60000;
          await Promise.race([
            performVirusScan(session.sessionId, session.fileKey),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Virus scan timeout')), VIRUS_SCAN_TIMEOUT_MS)
            ),
          ]);
        } catch (error) {
          logger.error('Virus scan failed', {
            sessionId: session.sessionId,
            fileKey: session.fileKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();

      sendSuccess(res, {
        sessionId: session.sessionId,
        uploadUrl: session.uploadUrl,
        publicUrl: session.publicUrl,
        expiresAt: session.expiresAt,
        fileKey: session.fileKey,
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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { fileName, fileSize, mimeType, chatSessionId, chunkSize, metadata } = req.body;
      const tenantId = req.tenantId!;
      const userId = req.userId!;

      logAudit(userId, 'CHUNKED_UPLOAD_INITIATED', 'upload', chatSessionId, tenantId, { fileName, fileSize, mimeType, ip: req.ip });

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

      sendSuccess(res, {
        sessionId: session.sessionId,
        uploadId,
        chunkUrls,
        totalChunks: chunkUrls.length,
        chunkSize: chunkSize || 5 * 1024 * 1024,
        expiresAt: session.expiresAt,
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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId, parts } = req.body;
      const tenantId = req.tenantId!;
      const userId = req.userId!;

      const session = await uploadService.completeChunkedUpload(sessionId, parts);

      // Virus scan with timeout protection (fire-and-forget)
      (async () => {
        try {
          const VIRUS_SCAN_TIMEOUT_MS = 60000;
          await Promise.race([
            performVirusScan(session.sessionId, session.fileKey),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Virus scan timeout')), VIRUS_SCAN_TIMEOUT_MS)
            ),
          ]);
        } catch (error) {
          logger.error('Virus scan failed', {
            sessionId: session.sessionId,
            fileKey: session.fileKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();

      logAudit(userId, 'CHUNKED_UPLOAD_COMPLETED', 'upload', sessionId, tenantId, { fileKey: session.fileKey, ip: req.ip });

      sendSuccess(res, {
        sessionId: session.sessionId,
        status: session.status,
        publicUrl: session.publicUrl,
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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const session = uploadService.getSession(sessionId);

      if (!session) {
        throw new NotFoundError('Upload session not found');
      }

      // Verify tenant access
      if (session.tenantId !== req.tenantId) {
        throw new ForbiddenError('Access denied');
      }

      sendSuccess(res, {
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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenantId = req.tenantId!;
      const quota = uploadService.getTenantQuota(tenantId);

      sendSuccess(res, {
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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId, fileKey, clean, threats } = req.body;

      // Verify webhook secret
      const webhookSecret = req.headers['x-webhook-secret'];
      if (webhookSecret !== process.env.UPLOAD_WEBHOOK_SECRET) {
        throw new UnauthorizedError('Invalid webhook secret');
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
            logger.error('Thumbnail generation error', { error, fileKey, sessionId });
          }
        }

        // Log successful scan
        logAudit(session.userId, 'FILE_SCAN_COMPLETED', 'upload', sessionId, session.tenantId, { fileKey, clean: true });
      } else if (session && !clean) {
        // Log quarantine
        logAudit(session.userId, 'FILE_QUARANTINED', 'upload', sessionId, session.tenantId, { fileKey, threats, severity: 'HIGH' });

        // Delete infected file
        await uploadService.deleteFile(fileKey);
      }

      sendSuccess(res, { ok: true });
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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { fileKey } = req.params;
      const tenantId = req.tenantId!;
      const userId = req.userId!;

      // Verify file belongs to tenant
      const metadata = await uploadService.getFileMetadata(fileKey);
      if (!metadata || metadata['tenant-id'] !== tenantId) {
        throw new ForbiddenError('Access denied');
      }

      await uploadService.deleteFile(fileKey);

      logAudit(userId, 'FILE_DELETED', 'upload', fileKey, tenantId, { ip: req.ip });

      sendSuccess(res, { message: 'File deleted successfully' });
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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { fileKey } = req.params;
      const { filename } = req.query;
      const tenantId = req.tenantId!;

      // Verify file belongs to tenant
      const metadata = await uploadService.getFileMetadata(fileKey);
      if (!metadata || metadata['tenant-id'] !== tenantId) {
        throw new ForbiddenError('Access denied');
      }

      const downloadUrl = await uploadService.generateDownloadUrl(
        fileKey,
        filename as string | undefined,
        300 // 5 minutes
      );

      logAudit(req.userId!, 'FILE_DOWNLOAD_REQUESTED', 'upload', fileKey, tenantId, { ip: req.ip });

      sendSuccess(res, {
        downloadUrl,
        expiresIn: 300,
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
          logger.error('Thumbnail generation error', { error, fileKey, sessionId, mimeType: session.mimeType });
        }
      }
    } else {
      // Delete infected file
      await uploadService.deleteFile(fileKey);
    }
  } catch (error) {
    logger.error('Virus scan error', { error, sessionId, fileKey });
    uploadService.updateSessionStatus(sessionId, 'failed');
  }
}

// ============================================================================
// Error Adapter
// ============================================================================
//
// Per plan §6.4: this is a thin adapter that converts framework / domain
// errors into typed `ApiError`s so the global `errorHandler` produces the
// canonical envelope. It must NOT write a response itself. Multer errors
// (`MulterError.code` like `LIMIT_FILE_SIZE`) flow through with their code
// preserved. Exported for unit testability.
export const uploadErrorAdapter = (
  err: Error,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (err instanceof FileValidationError) {
    return next(new ApiError(err.message, 400, ERROR_CODES.FILE_VALIDATION_FAILED));
  }
  if (err instanceof QuotaExceededError) {
    return next(new ApiError(err.message, 429, ERROR_CODES.QUOTA_EXCEEDED));
  }
  if (err instanceof multer.MulterError) {
    return next(new ApiError(err.message, 400, err.code));
  }
  return next(err);
};

router.use(uploadErrorAdapter);

// ============================================================================
// Exports
// ============================================================================

export default router;
export { router as uploadRouter };
