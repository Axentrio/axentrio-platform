/**
 * File Whitelist Service
 * White-label Chatbot Platform
 * 
 * Features:
 * - Configurable file type whitelist per tenant
 * - MIME type validation
 * - Extension-based filtering
 * - Category-based file types
 * - Policy enforcement
 */

// ============================================================================
// Types & Interfaces
// ============================================================================

export type FileCategory =
  | 'images'
  | 'documents'
  | 'videos'
  | 'audio'
  | 'archives'
  | 'code'
  | 'data'
  | 'fonts';

export interface FileTypeDefinition {
  mimeType: string;
  extensions: string[];
  category: FileCategory;
  maxSize: number;
  description: string;
  requiresScan: boolean;
  allowThumbnail: boolean;
}

export interface TenantFileWhitelist {
  tenantId: string;
  allowedCategories: FileCategory[];
  allowedMimeTypes: string[];
  blockedMimeTypes: string[];
  customFileTypes: FileTypeDefinition[];
  maxFileSize: number;
  maxTotalUploads: number;
  requireApproval: boolean;
  scanAllFiles: boolean;
}

export interface WhitelistCheckResult {
  allowed: boolean;
  reason?: string;
  fileType?: FileTypeDefinition;
  warnings: string[];
}

export interface FileInfo {
  filename: string;
  mimeType: string;
  size: number;
  extension: string;
}

// ============================================================================
// File Type Definitions
// ============================================================================

export const FILE_TYPE_DEFINITIONS: FileTypeDefinition[] = [
  // Images
  {
    mimeType: 'image/jpeg',
    extensions: ['.jpg', '.jpeg'],
    category: 'images',
    maxSize: 25 * 1024 * 1024,
    description: 'JPEG image',
    requiresScan: false,
    allowThumbnail: true,
  },
  {
    mimeType: 'image/png',
    extensions: ['.png'],
    category: 'images',
    maxSize: 25 * 1024 * 1024,
    description: 'PNG image',
    requiresScan: false,
    allowThumbnail: true,
  },
  {
    mimeType: 'image/gif',
    extensions: ['.gif'],
    category: 'images',
    maxSize: 25 * 1024 * 1024,
    description: 'GIF image',
    requiresScan: false,
    allowThumbnail: true,
  },
  {
    mimeType: 'image/webp',
    extensions: ['.webp'],
    category: 'images',
    maxSize: 25 * 1024 * 1024,
    description: 'WebP image',
    requiresScan: false,
    allowThumbnail: true,
  },
  {
    mimeType: 'image/svg+xml',
    extensions: ['.svg'],
    category: 'images',
    maxSize: 5 * 1024 * 1024,
    description: 'SVG image',
    requiresScan: true, // SVG can contain scripts
    allowThumbnail: false,
  },
  {
    mimeType: 'image/tiff',
    extensions: ['.tiff', '.tif'],
    category: 'images',
    maxSize: 50 * 1024 * 1024,
    description: 'TIFF image',
    requiresScan: false,
    allowThumbnail: true,
  },
  {
    mimeType: 'image/heic',
    extensions: ['.heic'],
    category: 'images',
    maxSize: 25 * 1024 * 1024,
    description: 'HEIC image',
    requiresScan: false,
    allowThumbnail: true,
  },
  {
    mimeType: 'image/avif',
    extensions: ['.avif'],
    category: 'images',
    maxSize: 25 * 1024 * 1024,
    description: 'AVIF image',
    requiresScan: false,
    allowThumbnail: true,
  },

  // Documents
  {
    mimeType: 'application/pdf',
    extensions: ['.pdf'],
    category: 'documents',
    maxSize: 50 * 1024 * 1024,
    description: 'PDF document',
    requiresScan: true,
    allowThumbnail: true,
  },
  {
    mimeType: 'application/msword',
    extensions: ['.doc'],
    category: 'documents',
    maxSize: 50 * 1024 * 1024,
    description: 'Microsoft Word document',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['.docx'],
    category: 'documents',
    maxSize: 50 * 1024 * 1024,
    description: 'Microsoft Word document (OpenXML)',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/vnd.ms-excel',
    extensions: ['.xls'],
    category: 'documents',
    maxSize: 50 * 1024 * 1024,
    description: 'Microsoft Excel spreadsheet',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['.xlsx'],
    category: 'documents',
    maxSize: 50 * 1024 * 1024,
    description: 'Microsoft Excel spreadsheet (OpenXML)',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/vnd.ms-powerpoint',
    extensions: ['.ppt'],
    category: 'documents',
    maxSize: 100 * 1024 * 1024,
    description: 'Microsoft PowerPoint presentation',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['.pptx'],
    category: 'documents',
    maxSize: 100 * 1024 * 1024,
    description: 'Microsoft PowerPoint presentation (OpenXML)',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'text/plain',
    extensions: ['.txt'],
    category: 'documents',
    maxSize: 10 * 1024 * 1024,
    description: 'Plain text file',
    requiresScan: false,
    allowThumbnail: false,
  },
  {
    mimeType: 'text/csv',
    extensions: ['.csv'],
    category: 'documents',
    maxSize: 50 * 1024 * 1024,
    description: 'CSV file',
    requiresScan: false,
    allowThumbnail: false,
  },
  {
    mimeType: 'text/markdown',
    extensions: ['.md', '.markdown'],
    category: 'documents',
    maxSize: 10 * 1024 * 1024,
    description: 'Markdown file',
    requiresScan: false,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/rtf',
    extensions: ['.rtf'],
    category: 'documents',
    maxSize: 50 * 1024 * 1024,
    description: 'Rich Text Format',
    requiresScan: true,
    allowThumbnail: false,
  },

  // Videos
  {
    mimeType: 'video/mp4',
    extensions: ['.mp4', '.m4v'],
    category: 'videos',
    maxSize: 500 * 1024 * 1024,
    description: 'MP4 video',
    requiresScan: false,
    allowThumbnail: true,
  },
  {
    mimeType: 'video/quicktime',
    extensions: ['.mov', '.qt'],
    category: 'videos',
    maxSize: 500 * 1024 * 1024,
    description: 'QuickTime video',
    requiresScan: false,
    allowThumbnail: true,
  },
  {
    mimeType: 'video/webm',
    extensions: ['.webm'],
    category: 'videos',
    maxSize: 500 * 1024 * 1024,
    description: 'WebM video',
    requiresScan: false,
    allowThumbnail: true,
  },
  {
    mimeType: 'video/avi',
    extensions: ['.avi'],
    category: 'videos',
    maxSize: 500 * 1024 * 1024,
    description: 'AVI video',
    requiresScan: false,
    allowThumbnail: true,
  },
  {
    mimeType: 'video/mpeg',
    extensions: ['.mpeg', '.mpg'],
    category: 'videos',
    maxSize: 500 * 1024 * 1024,
    description: 'MPEG video',
    requiresScan: false,
    allowThumbnail: true,
  },
  {
    mimeType: 'video/x-msvideo',
    extensions: ['.avi'],
    category: 'videos',
    maxSize: 500 * 1024 * 1024,
    description: 'AVI video',
    requiresScan: false,
    allowThumbnail: true,
  },

  // Audio
  {
    mimeType: 'audio/mpeg',
    extensions: ['.mp3'],
    category: 'audio',
    maxSize: 100 * 1024 * 1024,
    description: 'MP3 audio',
    requiresScan: false,
    allowThumbnail: false,
  },
  {
    mimeType: 'audio/wav',
    extensions: ['.wav'],
    category: 'audio',
    maxSize: 100 * 1024 * 1024,
    description: 'WAV audio',
    requiresScan: false,
    allowThumbnail: false,
  },
  {
    mimeType: 'audio/ogg',
    extensions: ['.ogg', '.oga'],
    category: 'audio',
    maxSize: 100 * 1024 * 1024,
    description: 'Ogg audio',
    requiresScan: false,
    allowThumbnail: false,
  },
  {
    mimeType: 'audio/aac',
    extensions: ['.aac'],
    category: 'audio',
    maxSize: 100 * 1024 * 1024,
    description: 'AAC audio',
    requiresScan: false,
    allowThumbnail: false,
  },
  {
    mimeType: 'audio/flac',
    extensions: ['.flac'],
    category: 'audio',
    maxSize: 200 * 1024 * 1024,
    description: 'FLAC audio',
    requiresScan: false,
    allowThumbnail: false,
  },
  {
    mimeType: 'audio/x-m4a',
    extensions: ['.m4a'],
    category: 'audio',
    maxSize: 100 * 1024 * 1024,
    description: 'M4A audio',
    requiresScan: false,
    allowThumbnail: false,
  },

  // Archives
  {
    mimeType: 'application/zip',
    extensions: ['.zip'],
    category: 'archives',
    maxSize: 100 * 1024 * 1024,
    description: 'ZIP archive',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/x-tar',
    extensions: ['.tar'],
    category: 'archives',
    maxSize: 100 * 1024 * 1024,
    description: 'TAR archive',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/gzip',
    extensions: ['.gz', '.gzip'],
    category: 'archives',
    maxSize: 100 * 1024 * 1024,
    description: 'GZIP archive',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/x-bzip2',
    extensions: ['.bz2'],
    category: 'archives',
    maxSize: 100 * 1024 * 1024,
    description: 'BZIP2 archive',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/x-7z-compressed',
    extensions: ['.7z'],
    category: 'archives',
    maxSize: 100 * 1024 * 1024,
    description: '7-Zip archive',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/x-rar-compressed',
    extensions: ['.rar'],
    category: 'archives',
    maxSize: 100 * 1024 * 1024,
    description: 'RAR archive',
    requiresScan: true,
    allowThumbnail: false,
  },

  // Data
  {
    mimeType: 'application/json',
    extensions: ['.json'],
    category: 'data',
    maxSize: 10 * 1024 * 1024,
    description: 'JSON file',
    requiresScan: false,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/xml',
    extensions: ['.xml'],
    category: 'data',
    maxSize: 10 * 1024 * 1024,
    description: 'XML file',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'text/xml',
    extensions: ['.xml'],
    category: 'data',
    maxSize: 10 * 1024 * 1024,
    description: 'XML file',
    requiresScan: true,
    allowThumbnail: false,
  },
  {
    mimeType: 'application/yaml',
    extensions: ['.yaml', '.yml'],
    category: 'data',
    maxSize: 10 * 1024 * 1024,
    description: 'YAML file',
    requiresScan: false,
    allowThumbnail: false,
  },

  // Fonts
  {
    mimeType: 'font/woff',
    extensions: ['.woff'],
    category: 'fonts',
    maxSize: 10 * 1024 * 1024,
    description: 'WOFF font',
    requiresScan: false,
    allowThumbnail: false,
  },
  {
    mimeType: 'font/woff2',
    extensions: ['.woff2'],
    category: 'fonts',
    maxSize: 10 * 1024 * 1024,
    description: 'WOFF2 font',
    requiresScan: false,
    allowThumbnail: false,
  },
  {
    mimeType: 'font/ttf',
    extensions: ['.ttf'],
    category: 'fonts',
    maxSize: 10 * 1024 * 1024,
    description: 'TrueType font',
    requiresScan: false,
    allowThumbnail: false,
  },
  {
    mimeType: 'font/otf',
    extensions: ['.otf'],
    category: 'fonts',
    maxSize: 10 * 1024 * 1024,
    description: 'OpenType font',
    requiresScan: false,
    allowThumbnail: false,
  },
];

// ============================================================================
// Blocked File Types (Security Risk)
// ============================================================================

export const BLOCKED_MIME_TYPES: string[] = [
  'application/x-msdownload', // .exe
  'application/x-msdos-program', // .exe
  'application/x-dosexec', // .exe
  'application/x-executable', // Unix executables
  'application/x-sh', // Shell scripts
  'application/x-bat', // Batch files
  'application/x-csh', // C shell scripts
  'text/x-perl', // Perl scripts
  'text/x-python', // Python scripts
  'text/x-ruby', // Ruby scripts
  'text/x-php', // PHP scripts
  'application/x-java-archive', // .jar
  'application/x-javascript', // JS files
  'text/javascript', // JS files
  'application/x-vbs', // VBScript
  'application/x-powershell', // PowerShell
];

export const BLOCKED_EXTENSIONS: string[] = [
  '.exe', '.dll', '.bat', '.cmd', '.sh', '.php', '.jsp', '.asp', '.aspx',
  '.py', '.rb', '.pl', '.cgi', '.jar', '.war', '.ear', '.ps1', '.vbs',
  '.js', '.wsf', '.hta', '.scr', '.com', '.pif', '.msi', '.msp', '.mst',
  '.reg', '.inf', '.ins', '.isp', '.ade', '.adp', '.app', '.bas', '.chm',
  '.cpl', '.crt', '.csh', '.fxp', '.hlp', '.ins', '.isp', '.jse', '.ksh',
  '.lnk', '.mda', '.mdb', '.mde', '.mdt', '.mdw', '.mdz', '.msc', '.ops',
  '.pcd', '.prf', '.prg', '.pst', '.scf', '.shb', '.shs', '.url', '.vb',
  '.vbe', '.vbs', '.wsc', '.wsf', '.wsh',
];

// ============================================================================
// File Whitelist Service
// ============================================================================

export class FileWhitelistService {
  private tenantWhitelists: Map<string, TenantFileWhitelist> = new Map();
  private fileTypeMap: Map<string, FileTypeDefinition> = new Map();
  private extensionMap: Map<string, FileTypeDefinition> = new Map();

  constructor() {
    this.buildFileTypeMaps();
  }

  private buildFileTypeMaps(): void {
    for (const fileType of FILE_TYPE_DEFINITIONS) {
      // Map MIME type to definition
      this.fileTypeMap.set(fileType.mimeType, fileType);

      // Map extensions to definition
      for (const ext of fileType.extensions) {
        this.extensionMap.set(ext.toLowerCase(), fileType);
      }
    }
  }

  // ==========================================================================
  // Tenant Whitelist Management
  // ==========================================================================

  /**
   * Set whitelist for a tenant
   */
  setTenantWhitelist(whitelist: TenantFileWhitelist): void {
    this.tenantWhitelists.set(whitelist.tenantId, whitelist);
  }

  /**
   * Get whitelist for a tenant
   */
  getTenantWhitelist(tenantId: string): TenantFileWhitelist {
    const existing = this.tenantWhitelists.get(tenantId);
    if (existing) return existing;

    // Return default whitelist
    return {
      tenantId,
      allowedCategories: ['images', 'documents', 'videos'],
      allowedMimeTypes: [],
      blockedMimeTypes: [],
      customFileTypes: [],
      maxFileSize: 25 * 1024 * 1024,
      maxTotalUploads: 1000,
      requireApproval: false,
      scanAllFiles: true,
    };
  }

  /**
   * Update tenant whitelist
   */
  updateTenantWhitelist(
    tenantId: string,
    updates: Partial<Omit<TenantFileWhitelist, 'tenantId'>>
  ): TenantFileWhitelist {
    const existing = this.getTenantWhitelist(tenantId);
    const updated = { ...existing, ...updates };
    this.tenantWhitelists.set(tenantId, updated);
    return updated;
  }

  /**
   * Remove tenant whitelist
   */
  removeTenantWhitelist(tenantId: string): boolean {
    return this.tenantWhitelists.delete(tenantId);
  }

  // ==========================================================================
  // File Type Lookup
  // ==========================================================================

  /**
   * Get file type definition by MIME type
   */
  getFileTypeByMimeType(mimeType: string): FileTypeDefinition | undefined {
    return this.fileTypeMap.get(mimeType);
  }

  /**
   * Get file type definition by extension
   */
  getFileTypeByExtension(extension: string): FileTypeDefinition | undefined {
    return this.extensionMap.get(extension.toLowerCase());
  }

  /**
   * Get file type definition by filename
   */
  getFileTypeByFilename(filename: string): FileTypeDefinition | undefined {
    const extension = this.extractExtension(filename);
    return this.getFileTypeByExtension(extension);
  }

  /**
   * Extract extension from filename
   */
  extractExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1) return '';
    return filename.substring(lastDot).toLowerCase();
  }

  /**
   * Get all file types in a category
   */
  getFileTypesByCategory(category: FileCategory): FileTypeDefinition[] {
    return FILE_TYPE_DEFINITIONS.filter((ft) => ft.category === category);
  }

  // ==========================================================================
  // Whitelist Checking
  // ==========================================================================

  /**
   * Check if a file is allowed for a tenant
   */
  checkFile(fileInfo: FileInfo, tenantId: string): WhitelistCheckResult {
    const whitelist = this.getTenantWhitelist(tenantId);
    const warnings: string[] = [];

    // Check blocked MIME types (global block)
    if (BLOCKED_MIME_TYPES.includes(fileInfo.mimeType)) {
      return {
        allowed: false,
        reason: `File type "${fileInfo.mimeType}" is blocked for security reasons`,
        warnings,
      };
    }

    // Check blocked extensions (global block)
    if (BLOCKED_EXTENSIONS.includes(fileInfo.extension.toLowerCase())) {
      return {
        allowed: false,
        reason: `File extension "${fileInfo.extension}" is blocked for security reasons`,
        warnings,
      };
    }

    // Check tenant-specific blocked MIME types
    if (whitelist.blockedMimeTypes.includes(fileInfo.mimeType)) {
      return {
        allowed: false,
        reason: `File type "${fileInfo.mimeType}" is blocked by tenant policy`,
        warnings,
      };
    }

    // Get file type definition
    let fileType = this.getFileTypeByMimeType(fileInfo.mimeType);

    // If not found by MIME type, try extension
    if (!fileType) {
      fileType = this.getFileTypeByExtension(fileInfo.extension);
      if (fileType) {
        warnings.push(`MIME type "${fileInfo.mimeType}" not recognized, using extension match`);
      }
    }

    // Check if MIME type is explicitly allowed
    if (whitelist.allowedMimeTypes.length > 0) {
      if (!whitelist.allowedMimeTypes.includes(fileInfo.mimeType)) {
        return {
          allowed: false,
          reason: `File type "${fileInfo.mimeType}" is not in the allowed list`,
          fileType,
          warnings,
        };
      }
    }

    // Check category
    if (fileType) {
      if (!whitelist.allowedCategories.includes(fileType.category)) {
        return {
          allowed: false,
          reason: `File category "${fileType.category}" is not allowed`,
          fileType,
          warnings,
        };
      }

      // Check file size against type-specific limit
      if (fileInfo.size > fileType.maxSize) {
        return {
          allowed: false,
          reason: `File size ${this.formatBytes(fileInfo.size)} exceeds maximum ${this.formatBytes(fileType.maxSize)} for ${fileType.description}`,
          fileType,
          warnings,
        };
      }
    }

    // Check against tenant max file size
    if (fileInfo.size > whitelist.maxFileSize) {
      return {
        allowed: false,
        reason: `File size ${this.formatBytes(fileInfo.size)} exceeds tenant maximum ${this.formatBytes(whitelist.maxFileSize)}`,
        fileType,
        warnings,
      };
    }

    // Check custom file types
    const customType = whitelist.customFileTypes.find(
      (ct) => ct.mimeType === fileInfo.mimeType || ct.extensions.includes(fileInfo.extension)
    );

    if (customType) {
      if (fileInfo.size > customType.maxSize) {
        return {
          allowed: false,
          reason: `File size exceeds maximum for custom type`,
          fileType: customType,
          warnings,
        };
      }
    }

    return {
      allowed: true,
      fileType,
      warnings,
    };
  }

  /**
   * Quick check if MIME type is allowed
   */
  isMimeTypeAllowed(mimeType: string, tenantId: string): boolean {
    const result = this.checkFile(
      { filename: 'test', mimeType, size: 100, extension: '' },
      tenantId
    );
    return result.allowed;
  }

  /**
   * Quick check if extension is allowed
   */
  isExtensionAllowed(extension: string, tenantId: string): boolean {
    const fileType = this.getFileTypeByExtension(extension);
    if (!fileType) return false;

    const whitelist = this.getTenantWhitelist(tenantId);
    return whitelist.allowedCategories.includes(fileType.category);
  }

  // ==========================================================================
  // Category Management
  // ==========================================================================

  /**
   * Get allowed categories for tenant
   */
  getAllowedCategories(tenantId: string): FileCategory[] {
    const whitelist = this.getTenantWhitelist(tenantId);
    return whitelist.allowedCategories;
  }

  /**
   * Set allowed categories for tenant
   */
  setAllowedCategories(tenantId: string, categories: FileCategory[]): void {
    const whitelist = this.getTenantWhitelist(tenantId);
    whitelist.allowedCategories = categories;
    this.tenantWhitelists.set(tenantId, whitelist);
  }

  /**
   * Add allowed category for tenant
   */
  addAllowedCategory(tenantId: string, category: FileCategory): void {
    const whitelist = this.getTenantWhitelist(tenantId);
    if (!whitelist.allowedCategories.includes(category)) {
      whitelist.allowedCategories.push(category);
    }
  }

  /**
   * Remove allowed category for tenant
   */
  removeAllowedCategory(tenantId: string, category: FileCategory): void {
    const whitelist = this.getTenantWhitelist(tenantId);
    whitelist.allowedCategories = whitelist.allowedCategories.filter((c) => c !== category);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Format bytes to human readable
   */
  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Get all available categories
   */
  getAllCategories(): FileCategory[] {
    return ['images', 'documents', 'videos', 'audio', 'archives', 'code', 'data', 'fonts'];
  }

  /**
   * Get category display name
   */
  getCategoryDisplayName(category: FileCategory): string {
    const names: Record<FileCategory, string> = {
      images: 'Images',
      documents: 'Documents',
      videos: 'Videos',
      audio: 'Audio',
      archives: 'Archives',
      code: 'Code Files',
      data: 'Data Files',
      fonts: 'Fonts',
    };
    return names[category] || category;
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  getStats(): {
    tenantCount: number;
    fileTypeCount: number;
    categories: FileCategory[];
  } {
    return {
      tenantCount: this.tenantWhitelists.size,
      fileTypeCount: FILE_TYPE_DEFINITIONS.length,
      categories: this.getAllCategories(),
    };
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let fileWhitelistServiceInstance: FileWhitelistService | null = null;

export function getFileWhitelistService(): FileWhitelistService {
  if (!fileWhitelistServiceInstance) {
    fileWhitelistServiceInstance = new FileWhitelistService();
  }
  return fileWhitelistServiceInstance;
}

export function resetFileWhitelistService(): void {
  fileWhitelistServiceInstance = null;
}

export default FileWhitelistService;
