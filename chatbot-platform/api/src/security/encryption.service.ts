/**
 * Encryption Service - AES-256 Encryption Helpers
 * White-label Chatbot Platform
 * 
 * Features:
 * - AES-256-GCM encryption/decryption
 * - Key rotation support
 * - Data at rest encryption
 * - Field-level encryption for PII
 * - Secure key management
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'crypto';
// promisify kept for potential future use

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface EncryptionConfig {
  algorithm: string;
  keyLength: number;
  ivLength: number;
  tagLength: number;
  saltLength: number;
  iterations: number;
}

export interface EncryptedData {
  encrypted: string;
  iv: string;
  tag: string;
  salt: string;
  version: number;
}

export interface KeyMetadata {
  id: string;
  createdAt: Date;
  expiresAt?: Date;
  purpose: 'data-encryption' | 'field-encryption' | 'token-signing' | 'api-key';
  isActive: boolean;
}

export interface FieldEncryptionOptions {
  keyId?: string;
  deterministic?: boolean;
  searchable?: boolean;
}

export interface EncryptedField {
  ciphertext: string;
  iv: string;
  tag: string;
  keyId: string;
  deterministic: boolean;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: EncryptionConfig = {
  algorithm: 'aes-256-gcm',
  keyLength: 32,
  ivLength: 16,
  tagLength: 16,
  saltLength: 32,
  iterations: 100000,
};

// ============================================================================
// Key Management
// ============================================================================

class KeyManager {
  private keys: Map<string, Buffer> = new Map();
  private metadata: Map<string, KeyMetadata> = new Map();
  private currentKeyId: string | null = null;

  constructor() {
    this.loadKeysFromEnvironment();
  }

  private loadKeysFromEnvironment(): void {
    // Load primary encryption key
    const primaryKey = process.env.ENCRYPTION_KEY;
    if (primaryKey) {
      this.addKey('primary', Buffer.from(primaryKey, 'base64'), {
        purpose: 'data-encryption',
        isActive: true,
      });
      this.currentKeyId = 'primary';
    }

    // Load field encryption key
    const fieldKey = process.env.FIELD_ENCRYPTION_KEY;
    if (fieldKey) {
      this.addKey('field-encryption', Buffer.from(fieldKey, 'base64'), {
        purpose: 'field-encryption',
        isActive: true,
      });
    }

    // Load legacy keys for decryption
    const legacyKeys = process.env.LEGACY_ENCRYPTION_KEYS;
    if (legacyKeys) {
      const keys = legacyKeys.split(',');
      keys.forEach((key, index) => {
        this.addKey(`legacy-${index}`, Buffer.from(key.trim(), 'base64'), {
          purpose: 'data-encryption',
          isActive: false,
        });
      });
    }
  }

  addKey(id: string, key: Buffer, metadata: Partial<KeyMetadata> = {}): void {
    if (key.length !== 32) {
      throw new EncryptionError(`Key must be 32 bytes, got ${key.length}`);
    }

    this.keys.set(id, key);
    this.metadata.set(id, {
      id,
      createdAt: new Date(),
      purpose: 'data-encryption',
      isActive: true,
      ...metadata,
    });

    if (metadata.isActive && !this.currentKeyId) {
      this.currentKeyId = id;
    }
  }

  getKey(id: string): Buffer | undefined {
    return this.keys.get(id);
  }

  getCurrentKey(): { id: string; key: Buffer } {
    if (!this.currentKeyId) {
      throw new EncryptionError('No encryption key configured');
    }

    const key = this.keys.get(this.currentKeyId);
    if (!key) {
      throw new EncryptionError('Current encryption key not found');
    }

    return { id: this.currentKeyId, key };
  }

  getMetadata(id: string): KeyMetadata | undefined {
    return this.metadata.get(id);
  }

  rotateKey(newKey: Buffer): string {
    const newKeyId = `key-${Date.now()}`;
    
    // Deactivate current key
    if (this.currentKeyId) {
      const currentMeta = this.metadata.get(this.currentKeyId);
      if (currentMeta) {
        currentMeta.isActive = false;
      }
    }

    // Add new key
    this.addKey(newKeyId, newKey, {
      purpose: 'data-encryption',
      isActive: true,
    });

    this.currentKeyId = newKeyId;
    return newKeyId;
  }

  listKeys(): KeyMetadata[] {
    return Array.from(this.metadata.values());
  }

  generateKey(): Buffer {
    return randomBytes(32);
  }

  deriveKey(password: string, salt: Buffer): Buffer {
    return scryptSync(password, salt, 32);
  }
}

export const keyManager = new KeyManager();

// ============================================================================
// Encryption Service
// ============================================================================

export class EncryptionService {
  private config: EncryptionConfig;

  constructor(config?: Partial<EncryptionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ==========================================================================
  // Symmetric Encryption (AES-256-GCM)
  // ==========================================================================

  /**
   * Encrypt data using AES-256-GCM
   */
  encrypt(plaintext: string, keyId?: string): EncryptedData {
    const key = keyId
      ? keyManager.getKey(keyId)!
      : keyManager.getCurrentKey().key;

    // Generate random IV and salt
    const iv = randomBytes(this.config.ivLength);
    const salt = randomBytes(this.config.saltLength);

    // Create cipher
    const cipher = createCipheriv(this.config.algorithm, key, iv, {
      authTagLength: this.config.tagLength,
    } as any);

    // Encrypt
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    // Get authentication tag
    const tag = (cipher as any).getAuthTag();

    return {
      encrypted,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      salt: salt.toString('base64'),
      version: 1,
    };
  }

  /**
   * Decrypt data using AES-256-GCM
   */
  decrypt(encryptedData: EncryptedData, keyId?: string): string {
    const id = keyId || 'primary';
    const key = keyManager.getKey(id);

    if (!key) {
      throw new EncryptionError(`Encryption key '${id}' not found`);
    }

    // Decode components
    const iv = Buffer.from(encryptedData.iv, 'base64');
    const tag = Buffer.from(encryptedData.tag, 'base64');

    // Create decipher
    const decipher = createDecipheriv(this.config.algorithm, key, iv, {
      authTagLength: this.config.tagLength,
    } as any);

    // Set authentication tag
    (decipher as any).setAuthTag(tag);

    // Decrypt
    let decrypted = decipher.update(encryptedData.encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Encrypt buffer data
   */
  encryptBuffer(plaintext: Buffer, keyId?: string): EncryptedData {
    const key = keyId
      ? keyManager.getKey(keyId)!
      : keyManager.getCurrentKey().key;

    const iv = randomBytes(this.config.ivLength);
    const salt = randomBytes(this.config.saltLength);

    const cipher = createCipheriv(this.config.algorithm, key, iv, {
      authTagLength: this.config.tagLength,
    } as any);

    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = (cipher as any).getAuthTag();

    return {
      encrypted: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      salt: salt.toString('base64'),
      version: 1,
    };
  }

  /**
   * Decrypt to buffer
   */
  decryptBuffer(encryptedData: EncryptedData, keyId?: string): Buffer {
    const id = keyId || 'primary';
    const key = keyManager.getKey(id);

    if (!key) {
      throw new EncryptionError(`Encryption key '${id}' not found`);
    }

    const iv = Buffer.from(encryptedData.iv, 'base64');
    const tag = Buffer.from(encryptedData.tag, 'base64');
    const encrypted = Buffer.from(encryptedData.encrypted, 'base64');

    const decipher = createDecipheriv(this.config.algorithm, key, iv, {
      authTagLength: this.config.tagLength,
    } as any);

    (decipher as any).setAuthTag(tag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  // ==========================================================================
  // Field-Level Encryption
  // ==========================================================================

  /**
   * Encrypt a field value
   * 
   * @param value - Value to encrypt
   * @param options - Encryption options
   * @returns Encrypted field object
   */
  encryptField(value: string, options: FieldEncryptionOptions = {}): EncryptedField {
    const keyId = options.keyId || 'field-encryption';
    const key = keyManager.getKey(keyId);

    if (!key) {
      throw new EncryptionError(`Field encryption key '${keyId}' not found`);
    }

    // For deterministic encryption, use a fixed IV derived from the value
    let iv: Buffer;
    if (options.deterministic) {
      iv = createHash('sha256').update(value).digest().slice(0, this.config.ivLength);
    } else {
      iv = randomBytes(this.config.ivLength);
    }

    const cipher = createCipheriv(this.config.algorithm, key, iv, {
      authTagLength: this.config.tagLength,
    } as any);

    let ciphertext = cipher.update(value, 'utf8', 'base64');
    ciphertext += cipher.final('base64');

    const tag = (cipher as any).getAuthTag();

    return {
      ciphertext,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      keyId,
      deterministic: options.deterministic || false,
    };
  }

  /**
   * Decrypt a field value
   */
  decryptField(encryptedField: EncryptedField): string {
    const key = keyManager.getKey(encryptedField.keyId);

    if (!key) {
      throw new EncryptionError(`Encryption key '${encryptedField.keyId}' not found`);
    }

    const iv = Buffer.from(encryptedField.iv, 'base64');
    const tag = Buffer.from(encryptedField.tag, 'base64');

    const decipher = createDecipheriv(this.config.algorithm, key, iv, {
      authTagLength: this.config.tagLength,
    } as any);

    (decipher as any).setAuthTag(tag);

    let decrypted = decipher.update(encryptedField.ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Generate search hash for encrypted field
   * Allows searching on encrypted data
   */
  generateSearchHash(value: string, keyId: string = 'field-encryption'): string {
    const key = keyManager.getKey(keyId);
    if (!key) {
      throw new EncryptionError(`Encryption key '${keyId}' not found`);
    }

    return createHmac('sha256', key).update(value.toLowerCase().trim()).digest('hex');
  }

  // ==========================================================================
  // Password Hashing
  // ==========================================================================

  /**
   * Hash a password using PBKDF2
   */
  hashPassword(password: string): string {
    const salt = randomBytes(32);
    const hash = scryptSync(password, salt, 64);

    return `${salt.toString('base64')}:${hash.toString('base64')}`;
  }

  /**
   * Verify a password against a hash
   */
  verifyPassword(password: string, hashedPassword: string): boolean {
    const [saltBase64, hashBase64] = hashedPassword.split(':');
    
    if (!saltBase64 || !hashBase64) {
      return false;
    }

    const salt = Buffer.from(saltBase64, 'base64');
    const expectedHash = Buffer.from(hashBase64, 'base64');
    const actualHash = scryptSync(password, salt, 64);

    try {
      return timingSafeEqual(expectedHash, actualHash);
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Token Generation
  // ==========================================================================

  /**
   * Generate a secure random token
   */
  generateToken(length: number = 32): string {
    return randomBytes(length).toString('base64url');
  }

  /**
   * Generate a secure random string (alphanumeric)
   */
  generateRandomString(length: number = 32): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const randomValues = randomBytes(length);
    
    for (let i = 0; i < length; i++) {
      result += chars[randomValues[i] % chars.length];
    }
    
    return result;
  }

  /**
   * Generate an API key
   */
  generateApiKey(): { key: string; hash: string; prefix: string } {
    const prefix = 'cb_' + this.generateRandomString(8);
    const secret = this.generateRandomString(32);
    const key = `${prefix}_${secret}`;
    const hash = createHash('sha256').update(key).digest('hex');

    return { key, hash, prefix };
  }

  /**
   * Hash an API key for storage
   */
  hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Verify an API key
   */
  verifyApiKey(apiKey: string, hash: string): boolean {
    const computedHash = this.hashApiKey(apiKey);
    
    try {
      return timingSafeEqual(Buffer.from(hash), Buffer.from(computedHash));
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Data Encryption at Rest
  // ==========================================================================

  /**
   * Encrypt an object for storage
   */
  encryptObject<T extends Record<string, any>>(
    obj: T,
    sensitiveFields: string[],
    keyId?: string
  ): T {
    const encrypted: any = { ...obj };

    for (const field of sensitiveFields) {
      if (encrypted[field] !== undefined && encrypted[field] !== null) {
        const value = String(encrypted[field]);
        const encryptedField = this.encryptField(value, { keyId, deterministic: false });
        encrypted[field] = JSON.stringify(encryptedField);
      }
    }

    return encrypted;
  }

  /**
   * Decrypt an object from storage
   */
  decryptObject<T extends Record<string, any>>(obj: T, encryptedFields: string[]): T {
    const decrypted: any = { ...obj };

    for (const field of encryptedFields) {
      if (decrypted[field] !== undefined && decrypted[field] !== null) {
        try {
          const encryptedField: EncryptedField = JSON.parse(decrypted[field]);
          decrypted[field] = this.decryptField(encryptedField);
        } catch {
          // Field might not be encrypted, leave as is
        }
      }
    }

    return decrypted;
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Create a hash of data
   */
  hash(data: string, algorithm: string = 'sha256'): string {
    return createHash(algorithm).update(data).digest('hex');
  }

  /**
   * Create an HMAC
   */
  hmac(data: string, key?: string): string {
    const hmacKey = key || process.env.HMAC_SECRET || 'default-secret';
    return createHmac('sha256', hmacKey).update(data).digest('hex');
  }

  /**
   * Compare two strings in constant time
   */
  secureCompare(a: string, b: string): boolean {
    try {
      return timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }

  /**
   * Serialize encrypted data to string
   */
  serialize(encryptedData: EncryptedData): string {
    return JSON.stringify(encryptedData);
  }

  /**
   * Deserialize encrypted data from string
   */
  deserialize(serialized: string): EncryptedData {
    return JSON.parse(serialized);
  }
}

// ============================================================================
// Custom Errors
// ============================================================================

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let encryptionServiceInstance: EncryptionService | null = null;

export function getEncryptionService(config?: Partial<EncryptionConfig>): EncryptionService {
  if (!encryptionServiceInstance) {
    encryptionServiceInstance = new EncryptionService(config);
  }
  return encryptionServiceInstance;
}

export function resetEncryptionService(): void {
  encryptionServiceInstance = null;
}

export default EncryptionService;
