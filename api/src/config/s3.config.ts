import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { config } from './environment';

/**
 * AWS S3 Configuration
 * Supports AWS S3 and S3-compatible services (MinIO, DigitalOcean Spaces, etc.)
 */

export interface S3Config {
  client: S3Client;
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  maxFileSize: number;
  signedUrlExpiry: number;
  cdnUrl?: string;
}

/**
 * Create S3 client based on environment configuration
 */
export function createS3Client(): S3Client {
  const clientConfig: S3ClientConfig = {
    region: config.s3.region || 'eu-west-1',
    credentials: {
      accessKeyId: config.s3.accessKeyId!,
      secretAccessKey: config.s3.secretAccessKey!,
    },
    maxAttempts: 3,
  };

  // Support S3-compatible services (MinIO, DigitalOcean Spaces, etc.)
  if (config.s3.endpoint) {
    clientConfig.endpoint = config.s3.endpoint;
    clientConfig.forcePathStyle = config.s3.forcePathStyle;
  }

  // Custom TLS settings for development
  if (!config.server.isProduction && config.s3.endpoint?.includes('localhost')) {
    clientConfig.tls = false;
  }

  return new S3Client(clientConfig);
}

/**
 * S3 configuration object
 */
export const s3Config: S3Config = {
  client: createS3Client(),
  bucket: config.s3.bucket!,
  region: config.s3.region || 'eu-west-1',
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  maxFileSize: config.fileUpload.maxFileSize,
  signedUrlExpiry: config.s3.signedUrlExpiry,
  cdnUrl: config.s3.cdnUrl,
};

/**
 * Get public URL for a file
 */
export function getPublicUrl(key: string): string {
  if (s3Config.cdnUrl) {
    return `${s3Config.cdnUrl}/${key}`;
  }

  if (s3Config.endpoint) {
    // S3-compatible service
    return `${s3Config.endpoint}/${s3Config.bucket}/${key}`;
  }

  // AWS S3
  return `https://${s3Config.bucket}.s3.${s3Config.region}.amazonaws.com/${key}`;
}

/**
 * Generate S3 key for file upload
 */
export function generateS3Key(
  tenantId: string,
  sessionId: string,
  fileName: string
): string {
  const timestamp = Date.now();
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `uploads/${tenantId}/${sessionId}/${timestamp}-${sanitizedFileName}`;
}

/**
 * Validate file type against whitelist
 */
export function validateFileType(
  mimeType: string,
  allowedTypes: string[]
): boolean {
  return allowedTypes.includes(mimeType);
}

/**
 * Get file category from MIME type
 */
export function getFileCategory(mimeType: string): 'image' | 'video' | 'audio' | 'document' | 'other' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (
    mimeType === 'application/pdf' ||
    mimeType.includes('word') ||
    mimeType.includes('excel') ||
    mimeType.includes('powerpoint') ||
    mimeType === 'text/plain'
  ) {
    return 'document';
  }
  return 'other';
}

export default s3Config;
