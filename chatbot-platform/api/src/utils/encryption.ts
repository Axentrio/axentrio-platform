/**
 * Encryption Utilities
 * AES-256 encryption for sensitive data
 */

import crypto from 'crypto';
import { config } from '../config/environment';
import { logger } from '../utils/logger';

// Constants
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = config.encryption.ivLength;
const AUTH_TAG_LENGTH = 16;
// Key length: 32 bytes for AES-256

// Derive key from config
const getKey = (): Buffer => {
  const keyString = config.encryption.key;
  // Ensure key is exactly 32 bytes
  return crypto.createHash('sha256').update(keyString).digest();
};

/**
 * Encrypt text using AES-256-GCM
 * @param text - Plain text to encrypt
 * @returns Encrypted string (base64 encoded: iv:authTag:ciphertext)
 */
export const encrypt = (text: string): string => {
  try {
    if (!text) {
      return text;
    }

    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Combine iv + authTag + encrypted data
    const result = Buffer.concat([iv, authTag, Buffer.from(encrypted, 'hex')]);
    return result.toString('base64');
  } catch (error) {
    logger.error('Encryption failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error('Failed to encrypt data');
  }
};

/**
 * Decrypt text using AES-256-GCM
 * @param encryptedData - Encrypted string (base64 encoded: iv:authTag:ciphertext)
 * @returns Decrypted plain text
 */
export const decrypt = (encryptedData: string): string => {
  try {
    if (!encryptedData) {
      return encryptedData;
    }

    const key = getKey();
    const data = Buffer.from(encryptedData, 'base64');

    // Extract iv, authTag, and encrypted content
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted.toString('hex'), 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    logger.error('Decryption failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error('Failed to decrypt data');
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
