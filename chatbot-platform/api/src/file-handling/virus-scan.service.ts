/**
 * Virus Scan Service - ClamAV Integration
 * White-label Chatbot Platform
 * 
 * Features:
 * - Real-time virus scanning via ClamAV
 * - Stream-based scanning for large files
 * - Quarantine management
 * - Scan result caching
 * - Health monitoring
 */

import { createConnection } from 'net';
import { Readable } from 'stream';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import NodeClam from 'clamscan';
import { config as appConfig } from '../config/environment';
import { logger } from '../utils/logger';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface VirusScanConfig {
  clamavHost: string;
  clamavPort: number;
  timeoutMs: number;
  maxFileSize: number;
  quarantineBucket?: string;
  enableStreaming: boolean;
  cacheResults: boolean;
  cacheTtlMs: number;
}

export interface ScanResult {
  clean: boolean;
  threats?: string[];
  scannedAt: Date;
  scanDurationMs: number;
  fileKey: string;
  scanMethod: 'streaming' | 'buffer' | 'clamd';
}

export interface QuarantineRecord {
  fileKey: string;
  originalTenantId: string;
  threats: string[];
  quarantinedAt: Date;
  quarantineKey: string;
}

export interface ClamAVHealth {
  healthy: boolean;
  version?: string;
  databaseVersion?: string;
  databaseDate?: Date;
  lastCheck: Date;
  error?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: VirusScanConfig = {
  clamavHost: process.env.CLAMAV_HOST || 'clamav',
  clamavPort: parseInt(process.env.CLAMAV_PORT || '3310'),
  timeoutMs: 60000, // 60 seconds
  maxFileSize: 25 * 1024 * 1024, // 25MB
  quarantineBucket: process.env.S3_QUARANTINE_BUCKET,
  enableStreaming: true,
  cacheResults: true,
  cacheTtlMs: 5 * 60 * 1000, // 5 minutes
};

// ============================================================================
// Virus Scan Service Class
// ============================================================================

export class VirusScanService {
  private config: VirusScanConfig;
  private s3Client: S3Client;
  private clamscan: NodeClam | null = null;
  private scanCache: Map<string, { result: ScanResult; expiresAt: Date }> = new Map();
  private quarantineRecords: Map<string, QuarantineRecord> = new Map();
  private healthStatus: ClamAVHealth = {
    healthy: false,
    lastCheck: new Date(0),
  };

  private enabled: boolean;

  constructor(config?: Partial<VirusScanConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.enabled = appConfig.clamav.enabled;

    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
    });

    if (!this.enabled) {
      logger.warn('ClamAV not configured — virus scanning disabled');
      return;
    }

    this.initializeClamScan();
    this.startHealthCheckScheduler();
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  private async initializeClamScan(): Promise<void> {
    try {
      this.clamscan = await new NodeClam().init({
        removeInfected: false,
        quarantineInfected: false,
        scanLog: null,
        debugMode: process.env.NODE_ENV === 'development',
        fileList: null,
        scanRecursively: true,
        clamscan: {
          path: '/usr/bin/clamscan',
          db: '/var/lib/clamav',
          scanArchives: true,
          active: true,
        },
        clamdscan: {
          socket: false,
          host: this.config.clamavHost,
          port: this.config.clamavPort,
          timeout: this.config.timeoutMs,
          localFallback: true,
          path: '/usr/bin/clamdscan',
          configFile: '/etc/clamav/clamd.conf',
          multiscan: true,
          reloadDb: false,
          active: true,
        },
        preference: 'clamdscan',
      });

      console.log('ClamAV initialized successfully');
    } catch (error) {
      console.error('Failed to initialize ClamAV:', error);
      // Service will fall back to TCP socket scanning
    }
  }

  // ==========================================================================
  // File Scanning
  // ==========================================================================

  /**
   * Scan a file from S3
   */
  async scanFile(fileKey: string): Promise<ScanResult> {
    if (!this.enabled) {
      return {
        clean: true,
        scannedAt: new Date(),
        scanDurationMs: 0,
        fileKey,
        scanMethod: 'buffer',
      };
    }

    const startTime = Date.now();

    // Check cache first
    const cached = this.getCachedResult(fileKey);
    if (cached) {
      return cached;
    }

    try {
      // Get file from S3
      const command = new GetObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET!,
        Key: fileKey,
      });

      const response = await this.s3Client.send(command);
      const contentLength = response.ContentLength || 0;

      // Use streaming for large files
      if (this.config.enableStreaming && contentLength > 5 * 1024 * 1024) {
        return this.scanStream(response.Body as Readable, fileKey, startTime);
      }

      // Buffer-based scanning for smaller files
      const chunks: Buffer[] = [];
      for await (const chunk of response.Body as Readable) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      return this.scanBuffer(buffer, fileKey, startTime);
    } catch (error) {
      console.error(`Error scanning file ${fileKey}:`, error);
      throw new VirusScanError(`Failed to scan file: ${(error as Error).message}`);
    }
  }

  /**
   * Scan a buffer
   */
  async scanBuffer(buffer: Buffer, fileKey: string, startTime?: number): Promise<ScanResult> {
    const scanStart = startTime || Date.now();

    // Check file size limit
    if (buffer.length > this.config.maxFileSize) {
      throw new VirusScanError(
        `File size ${buffer.length} exceeds maximum ${this.config.maxFileSize}`
      );
    }

    try {
      let result: ScanResult;

      // Try ClamScan module first
      if (this.clamscan) {
        const scanResult = await (this.clamscan as any).scanBuffer(buffer);
        result = {
          clean: !scanResult.isInfected,
          threats: scanResult.isInfected ? [scanResult.viruses.join(', ')] : undefined,
          scannedAt: new Date(),
          scanDurationMs: Date.now() - scanStart,
          fileKey,
          scanMethod: 'clamd',
        };
      } else {
        // Fall back to TCP socket scanning
        result = await this.scanViaTcpSocket(buffer, fileKey, scanStart);
      }

      // Cache result
      this.cacheResult(fileKey, result);

      return result;
    } catch (error) {
      console.error('Buffer scan error:', error);
      throw new VirusScanError(`Scan failed: ${(error as Error).message}`);
    }
  }

  /**
   * Scan a stream
   */
  private async scanStream(
    stream: Readable,
    fileKey: string,
    startTime: number
  ): Promise<ScanResult> {
    try {
      // For streaming, we need to use the TCP socket approach
      // Collect stream into buffer chunks and scan
      const chunks: Buffer[] = [];
      let totalSize = 0;

      for await (const chunk of stream) {
        chunks.push(chunk);
        totalSize += chunk.length;

        if (totalSize > this.config.maxFileSize) {
          throw new VirusScanError(
            `Stream size exceeds maximum ${this.config.maxFileSize}`
          );
        }
      }

      const buffer = Buffer.concat(chunks);
      return this.scanBuffer(buffer, fileKey, startTime);
    } catch (error) {
      console.error('Stream scan error:', error);
      throw new VirusScanError(`Stream scan failed: ${(error as Error).message}`);
    }
  }

  /**
   * Scan via TCP socket to clamd
   */
  private scanViaTcpSocket(
    buffer: Buffer,
    fileKey: string,
    startTime: number
  ): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.config.clamavPort, this.config.clamavHost);
      const chunks: Buffer[] = [];
      let timeout: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timeout);
        socket.destroy();
      };

      timeout = setTimeout(() => {
        cleanup();
        reject(new VirusScanError('Scan timeout'));
      }, this.config.timeoutMs);

      socket.on('connect', () => {
        // Send zINSTREAM command
        socket.write('zINSTREAM\0');

        // Send buffer in chunks
        const chunkSize = 4096;
        for (let i = 0; i < buffer.length; i += chunkSize) {
          const chunk = buffer.slice(i, i + chunkSize);
          const sizeBuffer = Buffer.alloc(4);
          sizeBuffer.writeUInt32BE(chunk.length, 0);
          socket.write(sizeBuffer);
          socket.write(chunk);
        }

        // Send termination
        const zeroBuffer = Buffer.alloc(4);
        zeroBuffer.writeUInt32BE(0, 0);
        socket.write(zeroBuffer);
      });

      socket.on('data', (data) => {
        chunks.push(data);
      });

      socket.on('end', () => {
        cleanup();
        const response = Buffer.concat(chunks).toString().trim();
        
        // Parse response: "stream: OK" or "stream: VIRUS_NAME FOUND"
        const isClean = response.includes('OK') && !response.includes('FOUND');
        const threats: string[] = [];

        if (!isClean && response.includes('FOUND')) {
          const match = response.match(/stream: (.+) FOUND/);
          if (match) {
            threats.push(match[1]);
          }
        }

        const result: ScanResult = {
          clean: isClean,
          threats: threats.length > 0 ? threats : undefined,
          scannedAt: new Date(),
          scanDurationMs: Date.now() - startTime,
          fileKey,
          scanMethod: 'streaming',
        };

        this.cacheResult(fileKey, result);
        resolve(result);
      });

      socket.on('error', (error) => {
        cleanup();
        reject(new VirusScanError(`Socket error: ${error.message}`));
      });
    });
  }

  // ==========================================================================
  // Batch Scanning
  // ==========================================================================

  /**
   * Scan multiple files
   */
  async scanMultiple(fileKeys: string[]): Promise<Map<string, ScanResult>> {
    const results = new Map<string, ScanResult>();
    const batchSize = 5; // Scan 5 files concurrently

    for (let i = 0; i < fileKeys.length; i += batchSize) {
      const batch = fileKeys.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map((key) => this.scanFile(key))
      );

      batchResults.forEach((result, index) => {
        const fileKey = batch[index];
        if (result.status === 'fulfilled') {
          results.set(fileKey, result.value);
        } else {
          results.set(fileKey, {
            clean: false,
            threats: ['Scan failed: ' + result.reason.message],
            scannedAt: new Date(),
            scanDurationMs: 0,
            fileKey,
            scanMethod: 'streaming',
          });
        }
      });
    }

    return results;
  }

  // ==========================================================================
  // Quarantine Management
  // ==========================================================================

  /**
   * Quarantine an infected file
   */
  async quarantineFile(
    fileKey: string,
    tenantId: string,
    threats: string[]
  ): Promise<QuarantineRecord> {
    if (!this.config.quarantineBucket) {
      throw new VirusScanError('Quarantine bucket not configured');
    }

    const quarantineKey = `quarantine/${tenantId}/${Date.now()}-${fileKey.replace(/\//g, '_')}`;

    // Copy to quarantine bucket
    const { CopyObjectCommand } = await import('@aws-sdk/client-s3');
    const copyCommand = new CopyObjectCommand({
      CopySource: `${process.env.AWS_S3_BUCKET}/${fileKey}`,
      Bucket: this.config.quarantineBucket,
      Key: quarantineKey,
      Metadata: {
        'original-key': fileKey,
        'tenant-id': tenantId,
        'threats': JSON.stringify(threats),
        'quarantined-at': new Date().toISOString(),
      },
    });

    await this.s3Client.send(copyCommand);

    const record: QuarantineRecord = {
      fileKey,
      originalTenantId: tenantId,
      threats,
      quarantinedAt: new Date(),
      quarantineKey,
    };

    this.quarantineRecords.set(fileKey, record);

    return record;
  }

  /**
   * Get quarantine record
   */
  getQuarantineRecord(fileKey: string): QuarantineRecord | undefined {
    return this.quarantineRecords.get(fileKey);
  }

  /**
   * List quarantined files for tenant
   */
  getQuarantinedFiles(tenantId: string): QuarantineRecord[] {
    return Array.from(this.quarantineRecords.values()).filter(
      (record) => record.originalTenantId === tenantId
    );
  }

  // ==========================================================================
  // Caching
  // ==========================================================================

  private getCachedResult(fileKey: string): ScanResult | undefined {
    if (!this.config.cacheResults) return undefined;

    const cached = this.scanCache.get(fileKey);
    if (cached && cached.expiresAt > new Date()) {
      return cached.result;
    }

    // Clean up expired entry
    if (cached) {
      this.scanCache.delete(fileKey);
    }

    return undefined;
  }

  private cacheResult(fileKey: string, result: ScanResult): void {
    if (!this.config.cacheResults) return;

    this.scanCache.set(fileKey, {
      result,
      expiresAt: new Date(Date.now() + this.config.cacheTtlMs),
    });

    // Clean old cache entries if cache is too large
    if (this.scanCache.size > 1000) {
      const now = new Date();
      for (const [key, entry] of this.scanCache.entries()) {
        if (entry.expiresAt < now) {
          this.scanCache.delete(key);
        }
      }
    }
  }

  // ==========================================================================
  // Health Monitoring
  // ==========================================================================

  private startHealthCheckScheduler(): void {
    // Check health every 5 minutes
    setInterval(() => {
      this.checkHealth();
    }, 5 * 60 * 1000);

    // Initial health check
    this.checkHealth();
  }

  async checkHealth(): Promise<ClamAVHealth> {
    try {
      const socket = createConnection(this.config.clamavPort, this.config.clamavHost);
      void Date.now(); // health check timing

      const health = await new Promise<ClamAVHealth>((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error('Health check timeout'));
        }, 10000);

        socket.on('connect', () => {
          // Send VERSION command
          socket.write('nVERSION\n');
        });

        socket.on('data', (data) => {
          clearTimeout(timeout);
          const version = data.toString().trim();
          socket.destroy();

          resolve({
            healthy: true,
            version,
            lastCheck: new Date(),
          });
        });

        socket.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      this.healthStatus = health;
      return health;
    } catch (error) {
      this.healthStatus = {
        healthy: false,
        error: (error as Error).message,
        lastCheck: new Date(),
      };
      return this.healthStatus;
    }
  }

  getHealthStatus(): ClamAVHealth {
    return this.healthStatus;
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  getStats(): {
    cacheSize: number;
    quarantineCount: number;
    health: ClamAVHealth;
  } {
    return {
      cacheSize: this.scanCache.size,
      quarantineCount: this.quarantineRecords.size,
      health: this.healthStatus,
    };
  }
}

// ============================================================================
// Custom Errors
// ============================================================================

export class VirusScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VirusScanError';
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let virusScanServiceInstance: VirusScanService | null = null;

export function getVirusScanService(config?: Partial<VirusScanConfig>): VirusScanService {
  if (!virusScanServiceInstance) {
    virusScanServiceInstance = new VirusScanService(config);
  }
  return virusScanServiceInstance;
}

export function resetVirusScanService(): void {
  virusScanServiceInstance = null;
}

export default VirusScanService;
