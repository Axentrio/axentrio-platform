/**
 * Validation Service - File Type and Size Validation
 * White-label Chatbot Platform
 * 
 * Features:
 * - Configurable file type whitelist per tenant
 * - MIME type validation with magic numbers
 * - File size validation
 * - Filename sanitization
 * - Content-type detection
 */

import { readFileSync } from 'fs';
import { extname } from 'path';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface FileValidationConfig {
  maxFileSize: number;
  allowedMimeTypes: string[];
  allowedExtensions: string[];
  blockedExtensions: string[];
  requireMagicNumberValidation: boolean;
  maxFilenameLength: number;
  sanitizeFilenames: boolean;
}

export interface TenantFilePolicy {
  tenantId: string;
  maxFileSize: number;
  allowedMimeTypes: string[];
  allowedExtensions: string[];
  blockedExtensions: string[];
  scanAllFiles: boolean;
  requireApproval: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitizedFilename?: string;
  detectedMimeType?: string;
}

export interface FileSignature {
  mimeType: string;
  extensions: string[];
  magicNumbers: number[][];
  offset: number;
}

// ============================================================================
// File Signatures (Magic Numbers)
// ============================================================================

const FILE_SIGNATURES: FileSignature[] = [
  // Images
  {
    mimeType: 'image/jpeg',
    extensions: ['.jpg', '.jpeg'],
    magicNumbers: [[0xff, 0xd8, 0xff]],
    offset: 0,
  },
  {
    mimeType: 'image/png',
    extensions: ['.png'],
    magicNumbers: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    offset: 0,
  },
  {
    mimeType: 'image/gif',
    extensions: ['.gif'],
    magicNumbers: [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    offset: 0,
  },
  {
    mimeType: 'image/webp',
    extensions: ['.webp'],
    magicNumbers: [[0x52, 0x49, 0x46, 0x46]], // RIFF header, followed by WEBP
    offset: 0,
  },
  {
    mimeType: 'image/tiff',
    extensions: ['.tiff', '.tif'],
    magicNumbers: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]],
    offset: 0,
  },
  {
    mimeType: 'image/bmp',
    extensions: ['.bmp'],
    magicNumbers: [[0x42, 0x4d]],
    offset: 0,
  },
  {
    mimeType: 'image/heic',
    extensions: ['.heic'],
    magicNumbers: [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]],
    offset: 0,
  },
  // Videos
  {
    mimeType: 'video/mp4',
    extensions: ['.mp4', '.m4v'],
    magicNumbers: [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]],
    offset: 0,
  },
  {
    mimeType: 'video/quicktime',
    extensions: ['.mov', '.qt'],
    magicNumbers: [[0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70]],
    offset: 0,
  },
  {
    mimeType: 'video/avi',
    extensions: ['.avi'],
    magicNumbers: [[0x52, 0x49, 0x46, 0x46]],
    offset: 0,
  },
  {
    mimeType: 'video/webm',
    extensions: ['.webm'],
    magicNumbers: [[0x1a, 0x45, 0xdf, 0xa3]],
    offset: 0,
  },
  // Documents
  {
    mimeType: 'application/pdf',
    extensions: ['.pdf'],
    magicNumbers: [[0x25, 0x50, 0x44, 0x46]],
    offset: 0,
  },
  {
    mimeType: 'application/msword',
    extensions: ['.doc'],
    magicNumbers: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    offset: 0,
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['.docx'],
    magicNumbers: [[0x50, 0x4b, 0x03, 0x04]],
    offset: 0,
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['.xlsx'],
    magicNumbers: [[0x50, 0x4b, 0x03, 0x04]],
    offset: 0,
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['.pptx'],
    magicNumbers: [[0x50, 0x4b, 0x03, 0x04]],
    offset: 0,
  },
  // Archives
  {
    mimeType: 'application/zip',
    extensions: ['.zip'],
    magicNumbers: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]],
    offset: 0,
  },
  {
    mimeType: 'application/gzip',
    extensions: ['.gz', '.gzip'],
    magicNumbers: [[0x1f, 0x8b]],
    offset: 0,
  },
  {
    mimeType: 'application/x-tar',
    extensions: ['.tar'],
    magicNumbers: [[0x75, 0x73, 0x74, 0x61, 0x72]],
    offset: 257,
  },
  // Audio
  {
    mimeType: 'audio/mpeg',
    extensions: ['.mp3'],
    magicNumbers: [[0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2], [0x49, 0x44, 0x33]],
    offset: 0,
  },
  {
    mimeType: 'audio/wav',
    extensions: ['.wav'],
    magicNumbers: [[0x52, 0x49, 0x46, 0x46]],
    offset: 0,
  },
  // Text
  {
    mimeType: 'text/plain',
    extensions: ['.txt', '.text'],
    magicNumbers: [], // No reliable magic number for text
    offset: 0,
  },
  {
    mimeType: 'text/csv',
    extensions: ['.csv'],
    magicNumbers: [],
    offset: 0,
  },
  {
    mimeType: 'application/json',
    extensions: ['.json'],
    magicNumbers: [],
    offset: 0,
  },
];

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
  'application/json',
];

const DEFAULT_BLOCKED_EXTENSIONS = [
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.sh',
  '.php',
  '.jsp',
  '.asp',
  '.aspx',
  '.py',
  '.rb',
  '.pl',
  '.cgi',
  '.jar',
  '.war',
  '.ear',
  '.ps1',
  '.vbs',
  '.js',
  '.wsf',
  '.hta',
  '.scr',
  '.com',
  '.pif',
  '.msi',
  '.msp',
  '.mst',
  '.reg',
  '.inf',
  '.ins',
  '.isp',
  '.ade',
  '.adp',
  '.app',
  '.bas',
  '.chm',
  '.cpl',
  '.crt',
  '.csh',
  '.fxp',
  '.hlp',
  '.hta',
  '.ins',
  '.isp',
  '.jse',
  '.ksh',
  '.lnk',
  '.mda',
  '.mdb',
  '.mde',
  '.mdt',
  '.mdw',
  '.mdz',
  '.msc',
  '.msi',
  '.msp',
  '.mst',
  '.ops',
  '.pcd',
  '.prf',
  '.prg',
  '.pst',
  '.scf',
  '.shb',
  '.shs',
  '.url',
  '.vb',
  '.vbe',
  '.vbs',
  '.wsc',
  '.wsf',
  '.wsh',
];

const DEFAULT_CONFIG: FileValidationConfig = {
  maxFileSize: 25 * 1024 * 1024, // 25MB
  allowedMimeTypes: DEFAULT_ALLOWED_MIME_TYPES,
  allowedExtensions: [],
  blockedExtensions: DEFAULT_BLOCKED_EXTENSIONS,
  requireMagicNumberValidation: true,
  maxFilenameLength: 255,
  sanitizeFilenames: true,
};

// ============================================================================
// Validation Service Class
// ============================================================================

export class ValidationService {
  private config: FileValidationConfig;
  private tenantPolicies: Map<string, TenantFilePolicy> = new Map();

  constructor(config?: Partial<FileValidationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ==========================================================================
  // Tenant Policy Management
  // ==========================================================================

  /**
   * Set file policy for a tenant
   */
  setTenantPolicy(policy: TenantFilePolicy): void {
    this.tenantPolicies.set(policy.tenantId, policy);
  }

  /**
   * Get file policy for a tenant
   */
  getTenantPolicy(tenantId: string): TenantFilePolicy {
    const existing = this.tenantPolicies.get(tenantId);
    if (existing) return existing;

    // Return default policy
    return {
      tenantId,
      maxFileSize: this.config.maxFileSize,
      allowedMimeTypes: this.config.allowedMimeTypes,
      allowedExtensions: this.config.allowedExtensions,
      blockedExtensions: this.config.blockedExtensions,
      scanAllFiles: true,
      requireApproval: false,
    };
  }

  /**
   * Update tenant policy
   */
  updateTenantPolicy(
    tenantId: string,
    updates: Partial<Omit<TenantFilePolicy, 'tenantId'>>
  ): TenantFilePolicy {
    const existing = this.getTenantPolicy(tenantId);
    const updated = { ...existing, ...updates };
    this.tenantPolicies.set(tenantId, updated);
    return updated;
  }

  /**
   * Remove tenant policy
   */
  removeTenantPolicy(tenantId: string): boolean {
    return this.tenantPolicies.delete(tenantId);
  }

  // ==========================================================================
  // Validation Methods
  // ==========================================================================

  /**
   * Validate file metadata (without reading file content)
   */
  validateFileMetadata(
    filename: string,
    mimeType: string,
    fileSize: number,
    tenantId?: string
  ): ValidationResult {
    const policy = tenantId ? this.getTenantPolicy(tenantId) : null;
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate file size
    const maxSize = policy?.maxFileSize || this.config.maxFileSize;
    if (fileSize > maxSize) {
      errors.push(`File size ${this.formatBytes(fileSize)} exceeds maximum ${this.formatBytes(maxSize)}`);
    }

    if (fileSize === 0) {
      errors.push('File is empty');
    }

    // Validate filename
    const filenameValidation = this.validateFilename(filename);
    if (!filenameValidation.valid) {
      errors.push(...filenameValidation.errors);
    }
    if (filenameValidation.warnings.length > 0) {
      warnings.push(...filenameValidation.warnings);
    }

    // Validate MIME type
    if (!this.isAllowedMimeType(mimeType, tenantId)) {
      errors.push(`MIME type "${mimeType}" is not allowed`);
    }

    // Validate extension
    const extension = extname(filename).toLowerCase();
    const blockedExtensions = policy?.blockedExtensions || this.config.blockedExtensions;
    const allowedExtensions = policy?.allowedExtensions || this.config.allowedExtensions;

    if (blockedExtensions.includes(extension)) {
      errors.push(`File extension "${extension}" is blocked for security reasons`);
    }

    if (allowedExtensions.length > 0 && !allowedExtensions.includes(extension)) {
      errors.push(`File extension "${extension}" is not in the allowed list`);
    }

    // Check for double extensions (potential security risk)
    const doubleExtMatch = filename.match(/\.[^.]+\.[^.]+$/);
    if (doubleExtMatch && !filename.match(/\.(tar\.gz|tar\.bz2|tar\.xz)$/)) {
      warnings.push('File has multiple extensions - verify file type before opening');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      sanitizedFilename: filenameValidation.sanitizedFilename,
    };
  }

  /**
   * Validate file buffer with magic number detection
   */
  async validateFileBuffer(
    buffer: Buffer,
    filename: string,
    claimedMimeType: string,
    tenantId?: string
  ): Promise<ValidationResult> {
    const metadataValidation = this.validateFileMetadata(
      filename,
      claimedMimeType,
      buffer.length,
      tenantId
    );

    if (!this.config.requireMagicNumberValidation) {
      return metadataValidation;
    }

    const errors = [...metadataValidation.errors];
    const warnings = [...metadataValidation.warnings];

    // Detect actual MIME type from magic numbers
    const detectedMimeType = this.detectMimeTypeFromBuffer(buffer);

    if (detectedMimeType) {
      // Verify claimed MIME type matches detected
      if (detectedMimeType !== claimedMimeType) {
        // Some MIME types are equivalent
        const equivalentTypes = this.getEquivalentMimeTypes(claimedMimeType);
        
        if (!equivalentTypes.includes(detectedMimeType)) {
          errors.push(
            `MIME type mismatch: claimed "${claimedMimeType}" but detected "${detectedMimeType}"`
          );
        }
      }

      // Verify extension matches detected MIME type
      const extension = extname(filename).toLowerCase();
      const expectedExtensions = this.getExtensionsForMimeType(detectedMimeType);
      
      if (expectedExtensions.length > 0 && !expectedExtensions.includes(extension)) {
        warnings.push(
          `File extension "${extension}" does not match detected type "${detectedMimeType}"`
        );
      }
    } else {
      // Could not detect MIME type from magic numbers
      // This is OK for text files, but suspicious for binary files
      if (!claimedMimeType.startsWith('text/') && claimedMimeType !== 'application/json') {
        warnings.push('Could not verify file type from content - proceed with caution');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      sanitizedFilename: metadataValidation.sanitizedFilename,
      detectedMimeType,
    };
  }

  /**
   * Validate file from disk path
   */
  async validateFile(
    filePath: string,
    filename: string,
    claimedMimeType: string,
    tenantId?: string
  ): Promise<ValidationResult> {
    try {
      const buffer = readFileSync(filePath);
      return this.validateFileBuffer(buffer, filename, claimedMimeType, tenantId);
    } catch (error) {
      return {
        valid: false,
        errors: [`Failed to read file: ${(error as Error).message}`],
        warnings: [],
      };
    }
  }

  // ==========================================================================
  // Filename Validation
  // ==========================================================================

  /**
   * Validate and sanitize filename
   */
  validateFilename(filename: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for null bytes
    if (filename.includes('\0')) {
      errors.push('Filename contains null bytes');
    }

    // Check length
    if (filename.length > this.config.maxFilenameLength) {
      errors.push(`Filename exceeds maximum length of ${this.config.maxFilenameLength} characters`);
    }

    if (filename.length === 0) {
      errors.push('Filename is empty');
    }

    // Check for path traversal attempts
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      errors.push('Filename contains path traversal characters');
    }

    // Check for control characters
    if (/[\x00-\x1f\x7f-\x9f]/.test(filename)) {
      errors.push('Filename contains control characters');
    }

    // Check for suspicious patterns
    const suspiciousPatterns = [
      /^\./, // Hidden files
      /\.$/, // Ends with dot
      /\s+$/, // Trailing whitespace
      /^\s+/, // Leading whitespace
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(filename)) {
        warnings.push(`Filename matches suspicious pattern: ${pattern}`);
      }
    }

    // Sanitize filename
    let sanitizedFilename: string | undefined;
    if (this.config.sanitizeFilenames) {
      sanitizedFilename = this.sanitizeFilename(filename);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      sanitizedFilename,
    };
  }

  /**
   * Sanitize filename
   */
  sanitizeFilename(filename: string): string {
    let sanitized = filename;

    // Remove path components
    sanitized = sanitized.replace(/^[\/\\]+/, '');
    sanitized = sanitized.replace(/[\/\\]/g, '_');

    // Remove null bytes
    sanitized = sanitized.replace(/\0/g, '');

    // Remove control characters
    sanitized = sanitized.replace(/[\x00-\x1f\x7f-\x9f]/g, '');

    // Remove path traversal
    sanitized = sanitized.replace(/\.\./g, '_');

    // Trim whitespace
    sanitized = sanitized.trim();

    // Replace multiple dots (except for known multi-extensions)
    if (!/\.(tar\.gz|tar\.bz2|tar\.xz)$/i.test(sanitized)) {
      const parts = sanitized.split('.');
      if (parts.length > 2) {
        const name = parts.slice(0, -1).join('_');
        const ext = parts[parts.length - 1];
        sanitized = `${name}.${ext}`;
      }
    }

    // Limit length
    if (sanitized.length > this.config.maxFilenameLength) {
      const ext = extname(sanitized);
      const name = sanitized.slice(0, this.config.maxFilenameLength - ext.length);
      sanitized = name + ext;
    }

    // Replace spaces with underscores
    sanitized = sanitized.replace(/\s+/g, '_');

    // Remove special characters
    sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, '_');

    // Ensure not empty
    if (!sanitized || sanitized === '.' || sanitized === '..') {
      sanitized = 'unnamed_file';
    }

    return sanitized;
  }

  // ==========================================================================
  // MIME Type Detection
  // ==========================================================================

  /**
   * Detect MIME type from file buffer using magic numbers
   */
  detectMimeTypeFromBuffer(buffer: Buffer): string | undefined {
    for (const signature of FILE_SIGNATURES) {
      for (const magicNumber of signature.magicNumbers) {
        if (this.matchesMagicNumber(buffer, magicNumber, signature.offset)) {
          return signature.mimeType;
        }
      }
    }

    // Special case for WebP (RIFF header with WEBP in bytes 8-11)
    if (buffer.length >= 12 && 
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return 'image/webp';
    }

    return undefined;
  }

  /**
   * Check if buffer matches magic number at offset
   */
  private matchesMagicNumber(buffer: Buffer, magicNumber: number[], offset: number): boolean {
    if (buffer.length < offset + magicNumber.length) {
      return false;
    }

    for (let i = 0; i < magicNumber.length; i++) {
      if (buffer[offset + i] !== magicNumber[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get MIME type from filename extension
   */
  getMimeTypeFromExtension(filename: string): string | undefined {
    const extension = extname(filename).toLowerCase();
    
    for (const signature of FILE_SIGNATURES) {
      if (signature.extensions.includes(extension)) {
        return signature.mimeType;
      }
    }

    return undefined;
  }

  /**
   * Get extensions for a MIME type
   */
  getExtensionsForMimeType(mimeType: string): string[] {
    const signature = FILE_SIGNATURES.find((s) => s.mimeType === mimeType);
    return signature?.extensions || [];
  }

  /**
   * Get equivalent MIME types (aliases)
   */
  getEquivalentMimeTypes(mimeType: string): string[] {
    const equivalents: Record<string, string[]> = {
      'image/jpeg': ['image/jpg', 'image/pjpeg'],
      'image/jpg': ['image/jpeg', 'image/pjpeg'],
      'text/plain': ['text/plain; charset=utf-8', 'text/plain; charset=iso-8859-1'],
      'application/octet-stream': [],
    };

    return [mimeType, ...(equivalents[mimeType] || [])];
  }

  // ==========================================================================
  // Policy Checks
  // ==========================================================================

  /**
   * Check if MIME type is allowed
   */
  isAllowedMimeType(mimeType: string, tenantId?: string): boolean {
    const policy = tenantId ? this.getTenantPolicy(tenantId) : null;
    const allowedList = policy?.allowedMimeTypes || this.config.allowedMimeTypes;

    // Check exact match
    if (allowedList.includes(mimeType)) {
      return true;
    }

    // Check wildcards (e.g., "image/*")
    for (const allowed of allowedList) {
      if (allowed.endsWith('/*')) {
        const prefix = allowed.slice(0, -1);
        if (mimeType.startsWith(prefix)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if extension is blocked
   */
  isBlockedExtension(extension: string, tenantId?: string): boolean {
    const policy = tenantId ? this.getTenantPolicy(tenantId) : null;
    const blockedList = policy?.blockedExtensions || this.config.blockedExtensions;
    
    return blockedList.includes(extension.toLowerCase());
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Format bytes to human readable string
   */
  formatBytes(bytes: number, decimals: number = 2): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  /**
   * Get all supported MIME types
   */
  getSupportedMimeTypes(): string[] {
    return FILE_SIGNATURES.map((s) => s.mimeType);
  }

  /**
   * Get all blocked extensions
   */
  getBlockedExtensions(): string[] {
    return [...this.config.blockedExtensions];
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  getStats(): {
    tenantPolicyCount: number;
    config: FileValidationConfig;
    supportedTypes: number;
  } {
    return {
      tenantPolicyCount: this.tenantPolicies.size,
      config: this.config,
      supportedTypes: FILE_SIGNATURES.length,
    };
  }
}

// ============================================================================
// Custom Errors
// ============================================================================

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let validationServiceInstance: ValidationService | null = null;

export function getValidationService(config?: Partial<FileValidationConfig>): ValidationService {
  if (!validationServiceInstance) {
    validationServiceInstance = new ValidationService(config);
  }
  return validationServiceInstance;
}

export function resetValidationService(): void {
  validationServiceInstance = null;
}

export default ValidationService;
