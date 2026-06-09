/**
 * Thumbnail Service - Image/Video Thumbnail Generation
 * White-label Chatbot Platform
 * 
 * Features:
 * - Image thumbnail generation with Sharp
 * - Video thumbnail extraction with FFmpeg
 * - Multiple size variants
 * - WebP optimization
 * - Lazy generation queue
 */

import sharp from 'sharp';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Readable } from 'stream';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface ThumbnailConfig {
  bucketName: string;
  region: string;
  sizes: ThumbnailSize[];
  quality: number;
  format: 'webp' | 'jpeg' | 'png';
  enableVideoThumbnails: boolean;
  videoThumbnailTime: string; // e.g., "00:00:01"
  maxDimension: number;
  cacheControl: string;
}

export interface ThumbnailSize {
  name: string;
  width: number;
  height: number;
  fit: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
}

export interface ThumbnailResult {
  originalKey: string;
  thumbnails: {
    size: string;
    url: string;
    width: number;
    height: number;
    fileSize: number;
  }[];
  generatedAt: Date;
}

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_SIZES: ThumbnailSize[] = [
  { name: 'thumb', width: 150, height: 150, fit: 'cover' },
  { name: 'small', width: 300, height: 300, fit: 'inside' },
  { name: 'medium', width: 600, height: 600, fit: 'inside' },
  { name: 'large', width: 1200, height: 1200, fit: 'inside' },
];

const DEFAULT_CONFIG: ThumbnailConfig = {
  bucketName: process.env.AWS_S3_BUCKET || '',
  region: process.env.AWS_REGION || 'us-east-1',
  sizes: DEFAULT_SIZES,
  quality: 80,
  format: 'webp',
  enableVideoThumbnails: true,
  videoThumbnailTime: '00:00:01',
  maxDimension: 4096,
  cacheControl: 'public, max-age=31536000, immutable',
};

// MIME types that support thumbnail generation
const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/tiff',
  'image/avif',
  'image/heic',
  'image/heif',
];

const VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/avi',
  'video/mpeg',
  'video/x-msvideo',
];

// ============================================================================
// Thumbnail Service Class
// ============================================================================

export class ThumbnailService {
  private config: ThumbnailConfig;
  private s3Client: S3Client;
  private generationQueue: Array<{
    fileKey: string;
    mimeType: string;
    resolve: (result: ThumbnailResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private isProcessingQueue = false;

  constructor(config?: Partial<ThumbnailConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.s3Client = new S3Client({
      region: this.config.region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
    });

    // Start queue processor
    this.processQueue();
  }

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Check if thumbnail should be generated for this MIME type
   */
  shouldGenerateThumbnail(mimeType: string): boolean {
    return (
      IMAGE_MIME_TYPES.includes(mimeType) ||
      (this.config.enableVideoThumbnails && VIDEO_MIME_TYPES.includes(mimeType))
    );
  }

  /**
   * Generate thumbnails for a file
   */
  async generateThumbnail(fileKey: string, mimeType: string): Promise<string> {
    if (!this.shouldGenerateThumbnail(mimeType)) {
      throw new ThumbnailError(`MIME type ${mimeType} does not support thumbnails`);
    }

    const result = await this.generateThumbnails(fileKey, mimeType);
    
    // Return the 'small' thumbnail URL or the first available
    const smallThumb = result.thumbnails.find((t) => t.size === 'small');
    return smallThumb?.url || result.thumbnails[0]?.url || '';
  }

  /**
   * Generate all thumbnail sizes
   */
  async generateThumbnails(fileKey: string, mimeType: string): Promise<ThumbnailResult> {
    if (IMAGE_MIME_TYPES.includes(mimeType)) {
      return this.generateImageThumbnails(fileKey);
    }

    if (VIDEO_MIME_TYPES.includes(mimeType)) {
      return this.generateVideoThumbnails(fileKey);
    }

    throw new ThumbnailError(`Unsupported MIME type: ${mimeType}`);
  }

  /**
   * Queue thumbnail generation
   */
  queueThumbnailGeneration(fileKey: string, mimeType: string): Promise<ThumbnailResult> {
    return new Promise((resolve, reject) => {
      this.generationQueue.push({
        fileKey,
        mimeType,
        resolve,
        reject,
      });

      if (!this.isProcessingQueue) {
        this.processQueue();
      }
    });
  }

  /**
   * Get thumbnail URL for a specific size
   */
  async getThumbnailUrl(fileKey: string, size: string = 'small'): Promise<string | null> {
    const thumbnailKey = this.getThumbnailKey(fileKey, size);
    
    try {
      // Check if thumbnail exists
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucketName,
          Key: thumbnailKey,
        })
      );

      // Generate signed URL
      const command = new GetObjectCommand({
        Bucket: this.config.bucketName,
        Key: thumbnailKey,
      });

      return getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Image Thumbnail Generation
  // ==========================================================================

  private async generateImageThumbnails(fileKey: string): Promise<ThumbnailResult> {
    const tempDir = await this.createTempDir();
    const inputPath = join(tempDir, 'input');

    try {
      // Download file from S3
      await this.downloadFromS3(fileKey, inputPath);

      // Get image metadata
      const metadata = await sharp(inputPath).metadata();
      const originalWidth = metadata.width || 0;
      const originalHeight = metadata.height || 0;

      // Generate the sizes in parallel — Sharp encode + S3 upload per size are
      // independent. The size list is a small fixed config so this is bounded;
      // Sharp's native work is already spread across libuv's threadpool.
      const thumbnails: ThumbnailResult['thumbnails'] = (
        await Promise.all(
          this.config.sizes.map(async (size) => {
            // Skip if original is smaller than target
            if (originalWidth < size.width && originalHeight < size.height) {
              return null;
            }

            const thumbnailKey = this.getThumbnailKey(fileKey, size.name);
            const outputPath = join(tempDir, `${size.name}.${this.config.format}`);

            // Generate thumbnail with Sharp
            await this.processImageWithSharp(inputPath, outputPath, size);

            // Upload to S3
            const fileBuffer = await fs.readFile(outputPath);
            await this.uploadToS3(thumbnailKey, fileBuffer, this.getContentType());

            // Get dimensions of generated thumbnail
            const thumbMetadata = await sharp(outputPath).metadata();

            // Generate URL
            const url = await this.generateThumbnailUrl(thumbnailKey);

            // Clean up temp file
            await fs.unlink(outputPath).catch(() => {});

            return {
              size: size.name,
              url,
              width: thumbMetadata.width || size.width,
              height: thumbMetadata.height || size.height,
              fileSize: fileBuffer.length,
            };
          }),
        )
      ).filter((t): t is NonNullable<typeof t> => t !== null);

      return {
        originalKey: fileKey,
        thumbnails,
        generatedAt: new Date(),
      };
    } finally {
      // Clean up temp directory
      await this.cleanupTempDir(tempDir);
    }
  }

  private async processImageWithSharp(
    inputPath: string,
    outputPath: string,
    size: ThumbnailSize
  ): Promise<void> {
    let pipeline = sharp(inputPath, {
      limitInputPixels: this.config.maxDimension * this.config.maxDimension,
    });

    // Apply resize
    pipeline = pipeline.resize(size.width, size.height, {
      fit: size.fit,
      withoutEnlargement: true,
    });

    // Apply format-specific settings
    switch (this.config.format) {
      case 'webp':
        pipeline = pipeline.webp({
          quality: this.config.quality,
          effort: 4,
          smartSubsample: true,
        });
        break;
      case 'jpeg':
        pipeline = pipeline.jpeg({
          quality: this.config.quality,
          progressive: true,
          mozjpeg: true,
        });
        break;
      case 'png':
        pipeline = pipeline.png({
          quality: this.config.quality,
          compressionLevel: 9,
          adaptiveFiltering: true,
        });
        break;
    }

    await pipeline.toFile(outputPath);
  }

  // ==========================================================================
  // Video Thumbnail Generation
  // ==========================================================================

  private async generateVideoThumbnails(fileKey: string): Promise<ThumbnailResult> {
    const tempDir = await this.createTempDir();
    const inputPath = join(tempDir, 'input.mp4');
    const thumbnailPath = join(tempDir, 'thumbnail.jpg');

    try {
      // Download file from S3
      await this.downloadFromS3(fileKey, inputPath);

      // Extract thumbnail using FFmpeg
      await this.extractVideoFrame(inputPath, thumbnailPath);

      // Generate thumbnails from extracted frame
      const thumbnails: ThumbnailResult['thumbnails'] = [];

      for (const size of this.config.sizes) {
        const thumbnailKey = this.getThumbnailKey(fileKey, size.name);
        const outputPath = join(tempDir, `${size.name}.${this.config.format}`);

        // Process with Sharp
        await this.processImageWithSharp(thumbnailPath, outputPath, size);

        // Upload to S3
        const fileBuffer = await fs.readFile(outputPath);
        await this.uploadToS3(thumbnailKey, fileBuffer, this.getContentType());

        // Get dimensions
        const thumbMetadata = await sharp(outputPath).metadata();

        // Generate URL
        const url = await this.generateThumbnailUrl(thumbnailKey);

        thumbnails.push({
          size: size.name,
          url,
          width: thumbMetadata.width || size.width,
          height: thumbMetadata.height || size.height,
          fileSize: fileBuffer.length,
        });

        // Clean up
        await fs.unlink(outputPath).catch(() => {});
      }

      return {
        originalKey: fileKey,
        thumbnails,
        generatedAt: new Date(),
      };
    } finally {
      await this.cleanupTempDir(tempDir);
    }
  }

  private extractVideoFrame(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', inputPath,
        '-ss', this.config.videoThumbnailTime,
        '-vframes', '1',
        '-q:v', '2',
        '-y',
        outputPath,
      ]);

      let stderr = '';

      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new ThumbnailError(`FFmpeg failed: ${stderr}`));
        }
      });

      ffmpeg.on('error', (error) => {
        reject(new ThumbnailError(`FFmpeg error: ${error.message}`));
      });
    });
  }

  /**
   * Get video information using FFprobe
   */
  async getVideoInfo(fileKey: string): Promise<VideoInfo> {
    const tempDir = await this.createTempDir();
    const inputPath = join(tempDir, 'input.mp4');

    try {
      await this.downloadFromS3(fileKey, inputPath);

      return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height,r_frame_rate,codec_name,duration',
          '-of', 'json',
          inputPath,
        ]);

        let stdout = '';
        let stderr = '';

        ffprobe.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        ffprobe.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        ffprobe.on('close', (code) => {
          if (code === 0) {
            try {
              const info = JSON.parse(stdout);
              const stream = info.streams[0];
              
              // Parse frame rate fraction
              const [num, den] = (stream.r_frame_rate || '30/1').split('/').map(Number);
              
              resolve({
                duration: parseFloat(stream.duration) || 0,
                width: stream.width || 0,
                height: stream.height || 0,
                fps: num / den,
                codec: stream.codec_name || 'unknown',
              });
            } catch (error) {
              reject(new ThumbnailError(`Failed to parse video info: ${error}`));
            }
          } else {
            reject(new ThumbnailError(`FFprobe failed: ${stderr}`));
          }
        });
      });
    } finally {
      await this.cleanupTempDir(tempDir);
    }
  }

  // ==========================================================================
  // Queue Processing
  // ==========================================================================

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.generationQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.generationQueue.length > 0) {
      const item = this.generationQueue.shift();
      if (!item) continue;

      try {
        const result = await this.generateThumbnails(item.fileKey, item.mimeType);
        item.resolve(result);
      } catch (error) {
        item.reject(error as Error);
      }

      // Small delay to prevent overwhelming the system
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.isProcessingQueue = false;
  }

  // ==========================================================================
  // S3 Operations
  // ==========================================================================

  private async downloadFromS3(fileKey: string, outputPath: string): Promise<void> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: fileKey,
    });

    const response = await this.s3Client.send(command);
    const stream = response.Body as Readable;

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    await fs.writeFile(outputPath, Buffer.concat(chunks));
  }

  private async uploadToS3(key: string, buffer: Buffer, contentType: string): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: this.config.cacheControl,
      ServerSideEncryption: 'AES256',
    });

    await this.s3Client.send(command);
  }

  private async generateThumbnailUrl(thumbnailKey: string): Promise<string> {
    // Use CloudFront if configured
    if (process.env.CLOUDFRONT_DOMAIN) {
      return `https://${process.env.CLOUDFRONT_DOMAIN}/${thumbnailKey}`;
    }

    const command = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: thumbnailKey,
    });

    return getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private getThumbnailKey(originalKey: string, size: string): string {
    const baseKey = originalKey.replace(/\.[^/.]+$/, '');
    return `${baseKey}.thumb.${size}.${this.config.format}`;
  }

  private getContentType(): string {
    switch (this.config.format) {
      case 'webp':
        return 'image/webp';
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      default:
        return 'image/webp';
    }
  }

  private async createTempDir(): Promise<string> {
    const tempDir = join(tmpdir(), `thumbnails-${uuidv4()}`);
    await fs.mkdir(tempDir, { recursive: true });
    return tempDir;
  }

  private async cleanupTempDir(tempDir: string): Promise<void> {
    try {
      const files = await fs.readdir(tempDir);
      await Promise.all(files.map((f) => fs.unlink(join(tempDir, f))));
      await fs.rmdir(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  getStats(): {
    queueLength: number;
    isProcessing: boolean;
    config: ThumbnailConfig;
  } {
    return {
      queueLength: this.generationQueue.length,
      isProcessing: this.isProcessingQueue,
      config: this.config,
    };
  }
}

// ============================================================================
// Custom Errors
// ============================================================================

export class ThumbnailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThumbnailError';
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let thumbnailServiceInstance: ThumbnailService | null = null;

export function getThumbnailService(config?: Partial<ThumbnailConfig>): ThumbnailService {
  if (!thumbnailServiceInstance) {
    thumbnailServiceInstance = new ThumbnailService(config);
  }
  return thumbnailServiceInstance;
}

export function resetThumbnailService(): void {
  thumbnailServiceInstance = null;
}

export default ThumbnailService;
