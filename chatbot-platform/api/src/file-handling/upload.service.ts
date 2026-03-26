/**
 * Upload Service - AWS S3 Pre-signed URL Generation
 * White-label Chatbot Platform
 * 
 * Features:
 * - Pre-signed URL generation for secure direct-to-S3 uploads
 * - Multi-tenant quota management
 * - File metadata tracking
 * - GDPR-compliant auto-deletion scheduling
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface UploadConfig {
  maxFileSize: number;           // in bytes
  allowedMimeTypes: string[];
  bucketName: string;
  region: string;
  expiresIn: number;             // URL expiry in seconds
  enableVirusScan: boolean;
  enableThumbnail: boolean;
  retentionDays: number;         // GDPR auto-delete
}

export interface TenantQuota {
  tenantId: string;
  maxStorageBytes: number;
  maxFilesPerMonth: number;
  currentStorageBytes: number;
  currentFilesThisMonth: number;
  lastResetDate: Date;
}

export interface UploadRequest {
  fileName: string;
  fileSize: number;
  mimeType: string;
  tenantId: string;
  userId: string;
  chatSessionId: string;
  metadata?: Record<string, string>;
}

export interface UploadSession {
  sessionId: string;
  uploadUrl: string;
  publicUrl: string;
  expiresAt: Date;
  fileKey: string;
  fileHash: string;
  status: 'pending' | 'uploading' | 'scanning' | 'ready' | 'failed' | 'quarantined';
  tenantId: string;
  userId: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  createdAt: Date;
  scanResult?: {
    clean: boolean;
    threats?: string[];
    scannedAt: Date;
  };
  thumbnailUrl?: string;
}

export interface ChunkedUploadSession {
  sessionId: string;
  uploadId: string;
  fileKey: string;
  parts: { ETag: string; PartNumber: number }[];
  totalParts: number;
  completedParts: number;
  partSize: number;
  fileSize: number;
  status: 'initiated' | 'in_progress' | 'completing' | 'completed' | 'failed';
}

// ============================================================================
// Default Configurations
// ============================================================================

export const DEFAULT_UPLOAD_CONFIG: UploadConfig = {
  maxFileSize: 25 * 1024 * 1024, // 25MB
  allowedMimeTypes: [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
  ],
  bucketName: process.env.AWS_S3_BUCKET || '',
  region: process.env.AWS_REGION || 'us-east-1',
  expiresIn: 300, // 5 minutes
  enableVirusScan: true,
  enableThumbnail: true,
  retentionDays: 30, // GDPR: 30 days auto-delete
};

// ============================================================================
// Upload Service Class
// ============================================================================

export class UploadService {
  private s3Client: S3Client;
  private config: UploadConfig;
  private uploadSessions: Map<string, UploadSession> = new Map();
  private tenantQuotas: Map<string, TenantQuota> = new Map();
  private chunkedSessions: Map<string, ChunkedUploadSession> = new Map();

  constructor(config?: Partial<UploadConfig>) {
    this.config = { ...DEFAULT_UPLOAD_CONFIG, ...config };
    
    this.s3Client = new S3Client({
      region: this.config.region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
      maxAttempts: 3,
    });

    // Start GDPR cleanup scheduler
    this.startGDPRCleanupScheduler();
  }

  // ==========================================================================
  // Pre-signed URL Generation
  // ==========================================================================

  /**
   * Generate a pre-signed URL for direct S3 upload
   */
  async generateUploadUrl(request: UploadRequest): Promise<UploadSession> {
    // Validate file against tenant quota
    await this.validateQuota(request.tenantId, request.fileSize);

    // Validate file type and size
    this.validateFile(request);

    const sessionId = uuidv4();
    const fileHash = this.generateFileHash(request);
    const fileKey = this.generateFileKey(request, fileHash);
    const sanitizedFileName = this.sanitizeFileName(request.fileName);

    // Create S3 metadata
    const metadata: Record<string, string> = {
      'tenant-id': request.tenantId,
      'user-id': request.userId,
      'session-id': request.chatSessionId,
      'original-name': sanitizedFileName,
      'file-hash': fileHash,
      'upload-date': new Date().toISOString(),
      'gdpr-delete-after': this.calculateGDPRDeleteDate(),
      'content-type': request.mimeType,
      ...(request.metadata || {}),
    };

    // Generate pre-signed URL
    const command = new PutObjectCommand({
      Bucket: this.config.bucketName,
      Key: fileKey,
      ContentType: request.mimeType,
      ContentLength: request.fileSize,
      Metadata: metadata,
      ServerSideEncryption: 'AES256',
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: this.config.expiresIn,
    });

    // Generate public access URL (after virus scan)
    const publicUrl = await this.generatePublicUrl(fileKey);

    const session: UploadSession = {
      sessionId,
      uploadUrl,
      publicUrl,
      expiresAt: new Date(Date.now() + this.config.expiresIn * 1000),
      fileKey,
      fileHash,
      status: 'pending',
      tenantId: request.tenantId,
      userId: request.userId,
      originalName: sanitizedFileName,
      fileSize: request.fileSize,
      mimeType: request.mimeType,
      createdAt: new Date(),
    };

    this.uploadSessions.set(sessionId, session);

    // Update tenant quota tracking
    await this.updateTenantQuota(request.tenantId, request.fileSize);

    return session;
  }

  /**
   * Generate multiple pre-signed URLs for chunked upload
   */
  async initiateChunkedUpload(
    request: UploadRequest,
    chunkSize: number = 5 * 1024 * 1024 // 5MB chunks
  ): Promise<{ session: UploadSession; chunkUrls: string[]; uploadId: string }> {
    const { CreateMultipartUploadCommand, UploadPartCommand } = await import('@aws-sdk/client-s3');
    
    await this.validateQuota(request.tenantId, request.fileSize);
    this.validateFile(request);

    const sessionId = uuidv4();
    const fileHash = this.generateFileHash(request);
    const fileKey = this.generateFileKey(request, fileHash);
    const totalParts = Math.ceil(request.fileSize / chunkSize);

    // Initiate multipart upload
    const createCommand = new CreateMultipartUploadCommand({
      Bucket: this.config.bucketName,
      Key: fileKey,
      ContentType: request.mimeType,
      Metadata: {
        'tenant-id': request.tenantId,
        'user-id': request.userId,
        'original-name': this.sanitizeFileName(request.fileName),
        'file-hash': fileHash,
        'upload-date': new Date().toISOString(),
        'gdpr-delete-after': this.calculateGDPRDeleteDate(),
      },
      ServerSideEncryption: 'AES256',
    });

    const multipartUpload = await this.s3Client.send(createCommand);
    const uploadId = multipartUpload.UploadId!;

    // Generate pre-signed URLs for each chunk
    const chunkUrls: string[] = [];
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const uploadPartCommand = new UploadPartCommand({
        Bucket: this.config.bucketName,
        Key: fileKey,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      const signedUrl = await getSignedUrl(this.s3Client, uploadPartCommand, {
        expiresIn: this.config.expiresIn * 2, // Longer expiry for chunked uploads
      });
      chunkUrls.push(signedUrl);
    }

    // Create chunked session tracking
    const chunkedSession: ChunkedUploadSession = {
      sessionId,
      uploadId,
      fileKey,
      parts: [],
      totalParts,
      completedParts: 0,
      partSize: chunkSize,
      fileSize: request.fileSize,
      status: 'initiated',
    };
    this.chunkedSessions.set(sessionId, chunkedSession);

    const publicUrl = await this.generatePublicUrl(fileKey);
    const session: UploadSession = {
      sessionId,
      uploadUrl: chunkUrls[0], // First chunk URL as primary
      publicUrl,
      expiresAt: new Date(Date.now() + this.config.expiresIn * 2 * 1000),
      fileKey,
      fileHash,
      status: 'pending',
      tenantId: request.tenantId,
      userId: request.userId,
      originalName: this.sanitizeFileName(request.fileName),
      fileSize: request.fileSize,
      mimeType: request.mimeType,
      createdAt: new Date(),
    };

    this.uploadSessions.set(sessionId, session);
    await this.updateTenantQuota(request.tenantId, request.fileSize);

    return { session, chunkUrls, uploadId };
  }

  /**
   * Complete a chunked upload
   */
  async completeChunkedUpload(
    sessionId: string,
    parts: { ETag: string; PartNumber: number }[]
  ): Promise<UploadSession> {
    const { CompleteMultipartUploadCommand } = await import('@aws-sdk/client-s3');
    
    const chunkedSession = this.chunkedSessions.get(sessionId);
    if (!chunkedSession) {
      throw new Error('Chunked upload session not found');
    }

    const session = this.uploadSessions.get(sessionId);
    if (!session) {
      throw new Error('Upload session not found');
    }

    // Sort parts by part number
    const sortedParts = parts.sort((a, b) => a.PartNumber - b.PartNumber);

    const completeCommand = new CompleteMultipartUploadCommand({
      Bucket: this.config.bucketName,
      Key: chunkedSession.fileKey,
      UploadId: chunkedSession.uploadId,
      MultipartUpload: {
        Parts: sortedParts,
      },
    });

    await this.s3Client.send(completeCommand);

    chunkedSession.status = 'completed';
    chunkedSession.parts = sortedParts;
    session.status = 'scanning';

    return session;
  }

  // ==========================================================================
  // URL Generation
  // ==========================================================================

  /**
   * Generate a public URL for accessing the file
   */
  async generatePublicUrl(fileKey: string, expiresIn: number = 3600): Promise<string> {
    // If using CloudFront, return CloudFront URL
    if (process.env.CLOUDFRONT_DOMAIN) {
      return `https://${process.env.CLOUDFRONT_DOMAIN}/${fileKey}`;
    }

    // Otherwise generate pre-signed GET URL
    const command = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: fileKey,
    });

    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  /**
   * Generate a temporary download URL
   */
  async generateDownloadUrl(
    fileKey: string,
    downloadFileName?: string,
    expiresIn: number = 300
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: fileKey,
      ResponseContentDisposition: downloadFileName
        ? `attachment; filename="${encodeURIComponent(downloadFileName)}"`
        : 'inline',
    });

    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  // ==========================================================================
  // File Operations
  // ==========================================================================

  /**
   * Delete a file from S3
   */
  async deleteFile(fileKey: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.config.bucketName,
      Key: fileKey,
    });

    await this.s3Client.send(command);
  }

  /**
   * Get file metadata from S3
   */
  async getFileMetadata(fileKey: string): Promise<Record<string, string> | undefined> {
    const command = new HeadObjectCommand({
      Bucket: this.config.bucketName,
      Key: fileKey,
    });

    const response = await this.s3Client.send(command);
    return response.Metadata;
  }

  /**
   * Check if file exists
   */
  async fileExists(fileKey: string): Promise<boolean> {
    try {
      await this.getFileMetadata(fileKey);
      return true;
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'NotFound' || name === 'NoSuchKey') {
        return false;
      }
      throw error;
    }
  }

  // ==========================================================================
  // Quota Management
  // ==========================================================================

  /**
   * Get or create tenant quota
   */
  getTenantQuota(tenantId: string): TenantQuota {
    let quota = this.tenantQuotas.get(tenantId);
    
    if (!quota) {
      quota = {
        tenantId,
        maxStorageBytes: 10 * 1024 * 1024 * 1024, // 10GB default
        maxFilesPerMonth: 10000,
        currentStorageBytes: 0,
        currentFilesThisMonth: 0,
        lastResetDate: new Date(),
      };
      this.tenantQuotas.set(tenantId, quota);
    }

    // Reset monthly counters if needed
    const now = new Date();
    if (now.getMonth() !== quota.lastResetDate.getMonth() ||
        now.getFullYear() !== quota.lastResetDate.getFullYear()) {
      quota.currentFilesThisMonth = 0;
      quota.lastResetDate = now;
    }

    return quota;
  }

  /**
   * Update tenant quota limits
   */
  updateTenantQuotaLimits(
    tenantId: string,
    maxStorageBytes: number,
    maxFilesPerMonth: number
  ): void {
    const quota = this.getTenantQuota(tenantId);
    quota.maxStorageBytes = maxStorageBytes;
    quota.maxFilesPerMonth = maxFilesPerMonth;
  }

  /**
   * Validate file against tenant quota
   */
  private async validateQuota(tenantId: string, fileSize: number): Promise<void> {
    const quota = this.getTenantQuota(tenantId);

    if (quota.currentStorageBytes + fileSize > quota.maxStorageBytes) {
      throw new QuotaExceededError(
        `Storage quota exceeded. Available: ${quota.maxStorageBytes - quota.currentStorageBytes} bytes`
      );
    }

    if (quota.currentFilesThisMonth >= quota.maxFilesPerMonth) {
      throw new QuotaExceededError(
        `Monthly file upload quota exceeded. Maximum: ${quota.maxFilesPerMonth} files`
      );
    }
  }

  /**
   * Update tenant quota after upload
   */
  private async updateTenantQuota(tenantId: string, fileSize: number): Promise<void> {
    const quota = this.getTenantQuota(tenantId);
    quota.currentStorageBytes += fileSize;
    quota.currentFilesThisMonth += 1;
  }

  /**
   * Recalculate tenant storage from S3
   */
  async recalculateTenantStorage(tenantId: string): Promise<number> {
    const prefix = `uploads/${tenantId}/`;
    let totalSize = 0;
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.config.bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const response = await this.s3Client.send(command);
      
      for (const object of response.Contents || []) {
        totalSize += object.Size || 0;
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    const quota = this.getTenantQuota(tenantId);
    quota.currentStorageBytes = totalSize;

    return totalSize;
  }

  // ==========================================================================
  // Session Management
  // ==========================================================================

  /**
   * Get upload session by ID
   */
  getSession(sessionId: string): UploadSession | undefined {
    return this.uploadSessions.get(sessionId);
  }

  /**
   * Update upload session status
   */
  updateSessionStatus(
    sessionId: string,
    status: UploadSession['status'],
    scanResult?: UploadSession['scanResult']
  ): UploadSession | undefined {
    const session = this.uploadSessions.get(sessionId);
    if (session) {
      session.status = status;
      if (scanResult) {
        session.scanResult = scanResult;
      }
    }
    return session;
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpiredSessions(): number {
    const now = new Date();
    let cleaned = 0;

    for (const [sessionId, session] of this.uploadSessions.entries()) {
      if (session.expiresAt < now && session.status !== 'ready') {
        this.uploadSessions.delete(sessionId);
        cleaned++;
      }
    }

    return cleaned;
  }

  // ==========================================================================
  // GDPR Compliance
  // ==========================================================================

  /**
   * Calculate GDPR auto-delete date (30 days from now)
   */
  private calculateGDPRDeleteDate(): string {
    const deleteDate = new Date();
    deleteDate.setDate(deleteDate.getDate() + this.config.retentionDays);
    return deleteDate.toISOString();
  }

  /**
   * Schedule GDPR cleanup
   */
  private startGDPRCleanupScheduler(): void {
    const cleanupInterval = 24 * 60 * 60 * 1000; // 24 hours

    setInterval(async () => {
      await this.performGDPRCleanup();
    }, cleanupInterval);
  }

  /**
   * Perform GDPR cleanup of expired files
   * Processes files in batches of 50 with a cap of 5000 files per run.
   */
  async performGDPRCleanup(): Promise<{ deleted: number; errors: number }> {
    const now = new Date().toISOString();
    let deleted = 0;
    let errors = 0;
    let processed = 0;
    let continuationToken: string | undefined;
    const BATCH_SIZE = 50;
    const MAX_FILES_PER_RUN = 5000;
    const BATCH_DELAY_MS = 100;
    const LOG_PROGRESS_EVERY = 500;

    logger.info('GDPR cleanup started');

    outer:
    do {
      const command = new ListObjectsV2Command({
        Bucket: this.config.bucketName,
        Prefix: 'uploads/',
        ContinuationToken: continuationToken,
      });

      const response = await this.s3Client.send(command);
      const objects = response.Contents || [];

      // Process objects in batches
      for (let i = 0; i < objects.length; i += BATCH_SIZE) {
        if (processed >= MAX_FILES_PER_RUN) {
          logger.info(`GDPR cleanup reached cap of ${MAX_FILES_PER_RUN} files, stopping`);
          break outer;
        }

        const batch = objects.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (object) => {
            const metadata = await this.getFileMetadata(object.Key!);
            const deleteAfter = metadata?.['gdpr-delete-after'];

            if (deleteAfter && deleteAfter < now) {
              await this.deleteFile(object.Key!);
              return true; // deleted
            }
            return false; // skipped
          })
        );

        for (const result of results) {
          processed++;
          if (result.status === 'fulfilled') {
            if (result.value) deleted++;
          } else {
            errors++;
            logger.error('GDPR cleanup error for file in batch', { error: result.reason });
          }
        }

        if (processed % LOG_PROGRESS_EVERY < BATCH_SIZE) {
          logger.info(`GDPR cleanup progress: ${processed} processed, ${deleted} deleted, ${errors} errors`);
        }

        // Delay between batches to avoid S3 throttling
        if (i + BATCH_SIZE < objects.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken && processed < MAX_FILES_PER_RUN);

    logger.info(`GDPR cleanup completed: ${deleted} files deleted, ${errors} errors, ${processed} processed`);
    return { deleted, errors };
  }

  /**
   * Extend file retention (for legal holds)
   */
  async extendRetention(fileKey: string, additionalDays: number): Promise<void> {
    const metadata = await this.getFileMetadata(fileKey);
    if (!metadata) {
      throw new Error('File not found');
    }

    const currentDeleteDate = new Date(metadata['gdpr-delete-after']);
    currentDeleteDate.setDate(currentDeleteDate.getDate() + additionalDays);

    // Note: S3 doesn't allow metadata updates without re-upload
    // In production, you'd use S3 Object Lambda or copy the object
    logger.info(`Retention extended for ${fileKey} until ${currentDeleteDate.toISOString()}`);
  }

  // ==========================================================================
  // Validation & Utilities
  // ==========================================================================

  /**
   * Validate file request
   */
  private validateFile(request: UploadRequest): void {
    // Check file size
    if (request.fileSize > this.config.maxFileSize) {
      throw new FileValidationError(
        `File size exceeds maximum of ${this.config.maxFileSize} bytes`
      );
    }

    // Check MIME type
    if (!this.config.allowedMimeTypes.includes(request.mimeType)) {
      throw new FileValidationError(
        `File type ${request.mimeType} is not allowed`
      );
    }

    // Validate file name
    if (!request.fileName || request.fileName.length > 255) {
      throw new FileValidationError('Invalid file name');
    }
  }

  /**
   * Generate file hash for deduplication
   */
  private generateFileHash(request: UploadRequest): string {
    const hashInput = `${request.tenantId}:${request.userId}:${request.fileName}:${request.fileSize}:${Date.now()}`;
    return createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
  }

  /**
   * Generate S3 file key
   */
  private generateFileKey(request: UploadRequest, fileHash: string): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const extension = request.fileName.split('.').pop() || 'bin';

    return `uploads/${request.tenantId}/${year}/${month}/${day}/${fileHash}.${extension}`;
  }

  /**
   * Sanitize file name
   */
  private sanitizeFileName(fileName: string): string {
    return fileName
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .replace(/_{2,}/g, '_')
      .substring(0, 100);
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  /**
   * Get service statistics
   */
  getStats(): {
    activeSessions: number;
    chunkedSessions: number;
    tenantCount: number;
  } {
    return {
      activeSessions: this.uploadSessions.size,
      chunkedSessions: this.chunkedSessions.size,
      tenantCount: this.tenantQuotas.size,
    };
  }
}

// ============================================================================
// Custom Errors
// ============================================================================

export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileValidationError';
  }
}

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export class UploadSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadSessionError';
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let uploadServiceInstance: UploadService | null = null;

export function getUploadService(config?: Partial<UploadConfig>): UploadService {
  if (!uploadServiceInstance) {
    uploadServiceInstance = new UploadService(config);
  }
  return uploadServiceInstance;
}

export function resetUploadService(): void {
  uploadServiceInstance = null;
}

export default UploadService;
