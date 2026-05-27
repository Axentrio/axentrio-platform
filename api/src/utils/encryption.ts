/**
 * Encryption Utilities
 * AES-256 encryption for sensitive data
 *
 * Version 1 (legacy): key derived via SHA-256
 * Version 2 (current): key derived via PBKDF2
 *
 * Encrypted payloads are prefixed with a single version byte so decrypt
 * can pick the correct key derivation automatically.
 */

import crypto from 'crypto';
import { config } from '../config/environment';
import { logger } from '../utils/logger';

// Constants
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = config.encryption.ivLength;
const AUTH_TAG_LENGTH = 16;

// PBKDF2 parameters for v2 key derivation
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_DIGEST = 'sha256';

// Version bytes written as the first byte of the encrypted payload
const VERSION_LEGACY = 0x01;
const VERSION_PBKDF2 = 0x02;

// ---------------------------------------------------------------------------
// Key derivation (memoised — keys never change at runtime)
// ---------------------------------------------------------------------------

let _cachedLegacyKey: Buffer | null = null;
let _cachedPbkdf2Key: Buffer | null = null;

/** Legacy (v1) key: SHA-256 of the raw config string. */
const getLegacyKey = (): Buffer => {
  if (_cachedLegacyKey) return _cachedLegacyKey;
  const keyString = config.encryption.key;
  _cachedLegacyKey = crypto.createHash('sha256').update(keyString).digest();
  return _cachedLegacyKey;
};

/**
 * Deterministic salt derived from the encryption key config value.
 * Using a key-specific salt keeps derivation deterministic (same key config
 * always produces the same derived key) while still adding cost via PBKDF2.
 */
const getPbkdf2Salt = (): Buffer => {
  return crypto
    .createHash('sha256')
    .update(`pbkdf2-salt:${config.encryption.key}`)
    .digest();
};

/** v2 key: PBKDF2 of the raw config string with a deterministic salt. */
const getPbkdf2Key = (): Buffer => {
  if (_cachedPbkdf2Key) return _cachedPbkdf2Key;
  const keyString = config.encryption.key;
  _cachedPbkdf2Key = crypto.pbkdf2Sync(
    keyString,
    getPbkdf2Salt(),
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    PBKDF2_DIGEST,
  );
  return _cachedPbkdf2Key;
};

// ---------------------------------------------------------------------------
// Custom error for decryption failures
// ---------------------------------------------------------------------------

export class DecryptionError extends Error {
  /** Optional message entity ID for debugging — never contains content. */
  public readonly messageId?: string;

  constructor(reason: string, messageId?: string) {
    super(reason);
    this.name = 'DecryptionError';
    this.messageId = messageId;
  }
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt text using AES-256-GCM (v2 — PBKDF2-derived key).
 * The output is base64-encoded: versionByte + iv + authTag + ciphertext.
 */
export const encrypt = (text: string): string => {
  try {
    if (!text) {
      return text;
    }

    const key = getPbkdf2Key();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // version byte + iv + authTag + ciphertext
    const result = Buffer.concat([
      Buffer.from([VERSION_PBKDF2]),
      iv,
      authTag,
      Buffer.from(encrypted, 'hex'),
    ]);
    return result.toString('base64');
  } catch (error) {
    logger.error('Encryption failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error('Failed to encrypt data');
  }
};

/**
 * Decrypt text using AES-256-GCM.
 *
 * Automatically detects the version byte to choose key derivation:
 *   0x02 → PBKDF2 (current)
 *   anything else → legacy SHA-256 (backward-compatible)
 *
 * @param encryptedData - base64-encoded ciphertext
 * @param messageId - optional message ID for error context (never logged content)
 */
export const decrypt = (encryptedData: string, messageId?: string): string => {
  try {
    if (!encryptedData) {
      return encryptedData;
    }

    const data = Buffer.from(encryptedData, 'base64');

    let key: Buffer;
    let payloadOffset: number;

    const versionByte = data[0];

    if (versionByte === VERSION_PBKDF2) {
      // v2: first byte is version, then iv + authTag + ciphertext
      key = getPbkdf2Key();
      payloadOffset = 1;
    } else if (versionByte === VERSION_LEGACY) {
      // Explicitly tagged v1
      key = getLegacyKey();
      payloadOffset = 1;
    } else {
      // Untagged legacy payload (written before versioning was added)
      key = getLegacyKey();
      payloadOffset = 0;
    }

    const iv = data.subarray(payloadOffset, payloadOffset + IV_LENGTH);
    const authTag = data.subarray(
      payloadOffset + IV_LENGTH,
      payloadOffset + IV_LENGTH + AUTH_TAG_LENGTH,
    );
    const encrypted = data.subarray(payloadOffset + IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted.toString('hex'), 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Decryption failed', {
      error: reason,
      ...(messageId ? { messageId } : {}),
    });
    throw new DecryptionError(`Failed to decrypt data: ${reason}`, messageId);
  }
};

/**
 * Hash data using SHA-256
 * @param data - Data to hash
 * @returns Hashed string (hex encoded)
 */
export const hash = (data: string): string => {
  return crypto.createHash('sha256').update(data).digest('hex');
};

/**
 * Generate a secure random token
 * @param length - Token length in bytes (default: 32)
 * @returns Random token (hex encoded)
 */
export const generateToken = (length: number = 32): string => {
  return crypto.randomBytes(length).toString('hex');
};

/**
 * Generate a secure API key
 * @returns API key with prefix
 */
export const generateApiKey = (): string => {
  const prefix = 'cb_';
  const randomPart = crypto.randomBytes(32).toString('base64url');
  return `${prefix}${randomPart}`;
};

/**
 * Generate a secure session ID
 * @returns Session ID
 */
export const generateSessionId = (): string => {
  return crypto.randomBytes(16).toString('hex');
};

/**
 * Compare two strings in constant time (to prevent timing attacks)
 * @param a - First string
 * @param b - Second string
 * @returns True if strings are equal
 */
export const secureCompare = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

/**
 * Encrypt object data (converts to JSON first)
 * @param data - Object to encrypt
 * @returns Encrypted string
 */
export const encryptObject = <T>(data: T): string => {
  const jsonString = JSON.stringify(data);
  return encrypt(jsonString);
};

/**
 * Decrypt object data (parses JSON)
 * @param encryptedData - Encrypted string
 * @returns Decrypted object
 */
export const decryptObject = <T>(encryptedData: string): T => {
  const jsonString = decrypt(encryptedData);
  return JSON.parse(jsonString) as T;
};

/**
 * Generate HMAC signature
 * @param data - Data to sign
 * @param secret - Secret key
 * @returns HMAC signature (hex encoded)
 */
export const generateHmac = (data: string, secret: string): string => {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
};

/**
 * Verify HMAC signature
 * @param data - Original data
 * @param signature - Signature to verify
 * @param secret - Secret key
 * @returns True if signature is valid
 */
export const verifyHmac = (data: string, signature: string, secret: string): boolean => {
  const expectedSignature = generateHmac(data, secret);
  return secureCompare(signature, expectedSignature);
};

/**
 * Check if a string appears to be encrypted
 * @param data - String to check
 * @returns True if likely encrypted
 */
export const isEncrypted = (data: string): boolean => {
  if (!data || typeof data !== 'string') {
    return false;
  }
  try {
    const buffer = Buffer.from(data, 'base64');
    // Check if it has the minimum length for IV + authTag + some data
    return buffer.length >= IV_LENGTH + AUTH_TAG_LENGTH + 1;
  } catch {
    return false;
  }
};

export default {
  encrypt,
  decrypt,
  DecryptionError,
  hash,
  generateToken,
  generateApiKey,
  generateSessionId,
  secureCompare,
  encryptObject,
  decryptObject,
  generateHmac,
  verifyHmac,
  isEncrypted,
};
