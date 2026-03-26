import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  hash,
  generateToken,
  generateApiKey,
  generateSessionId,
  secureCompare,
  encryptObject,
  decryptObject,
  isEncrypted,
  generateHmac,
  verifyHmac,
  DecryptionError,
} from '../../utils/encryption';

describe('Encryption Utils', () => {
  describe('encrypt / decrypt', () => {
    it('should roundtrip a string', () => {
      const plaintext = 'Hello, world!';
      const encrypted = encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it('should return empty string for empty input', () => {
      expect(encrypt('')).toBe('');
      expect(decrypt('')).toBe('');
    });

    it('should handle unicode characters', () => {
      const text = 'Bonjour le monde! 日本語テスト';
      expect(decrypt(encrypt(text))).toBe(text);
    });

    it('should produce different ciphertext each time (random IV)', () => {
      const text = 'same input';
      const a = encrypt(text);
      const b = encrypt(text);
      expect(a).not.toBe(b);
      expect(decrypt(a)).toBe(text);
      expect(decrypt(b)).toBe(text);
    });

    it('should throw DecryptionError for tampered ciphertext', () => {
      const encrypted = encrypt('secret');
      const tampered = encrypted.slice(0, -4) + 'XXXX';
      expect(() => decrypt(tampered)).toThrow(DecryptionError);
    });

    it('should include messageId in DecryptionError when provided', () => {
      try {
        decrypt('invalid-base64-data', 'msg-123');
      } catch (e) {
        expect(e).toBeInstanceOf(DecryptionError);
        expect((e as DecryptionError).messageId).toBe('msg-123');
      }
    });
  });

  describe('encryptObject / decryptObject', () => {
    it('should roundtrip a JSON object', () => {
      const obj = { name: 'test', count: 42, nested: { key: 'val' } };
      const encrypted = encryptObject(obj);
      expect(decryptObject(encrypted)).toEqual(obj);
    });
  });

  describe('hash', () => {
    it('should produce consistent SHA-256 hex', () => {
      const h1 = hash('test');
      const h2 = hash('test');
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64);
    });

    it('should produce different hashes for different inputs', () => {
      expect(hash('a')).not.toBe(hash('b'));
    });
  });

  describe('generateToken', () => {
    it('should return hex string of correct length', () => {
      const token = generateToken(16);
      expect(token).toHaveLength(32);
    });

    it('should default to 32 bytes', () => {
      expect(generateToken()).toHaveLength(64);
    });
  });

  describe('generateApiKey', () => {
    it('should start with cb_ prefix', () => {
      expect(generateApiKey()).toMatch(/^cb_/);
    });
  });

  describe('generateSessionId', () => {
    it('should return 32-char hex string', () => {
      expect(generateSessionId()).toHaveLength(32);
    });
  });

  describe('secureCompare', () => {
    it('should return true for equal strings', () => {
      expect(secureCompare('abc', 'abc')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(secureCompare('abc', 'xyz')).toBe(false);
    });

    it('should return false for different lengths', () => {
      expect(secureCompare('short', 'longer string')).toBe(false);
    });
  });

  describe('HMAC', () => {
    it('should generate and verify HMAC', () => {
      const data = 'payload';
      const secret = 'secret-key';
      const hmac = generateHmac(data, secret);
      expect(verifyHmac(data, hmac, secret)).toBe(true);
    });

    it('should reject wrong secret', () => {
      const hmac = generateHmac('data', 'secret');
      expect(verifyHmac('data', hmac, 'wrong-secret')).toBe(false);
    });
  });

  describe('isEncrypted', () => {
    it('should return true for encrypted data', () => {
      const encrypted = encrypt('test');
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('should return false for plain text', () => {
      expect(isEncrypted('hello')).toBe(false);
    });

    it('should return false for empty/null input', () => {
      expect(isEncrypted('')).toBe(false);
      expect(isEncrypted(null as unknown as string)).toBe(false);
    });
  });
});
