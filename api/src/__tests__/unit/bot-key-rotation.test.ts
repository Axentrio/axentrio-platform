import { describe, it, expect } from 'vitest';
import { generatePublicKey, PUBLIC_KEY_ENTROPY_BYTES } from '../../services/bot-key-rotation.service';

describe('generatePublicKey', () => {
  it('returns a short bk_-prefixed base64url id', () => {
    const key = generatePublicKey();
    // 12 bytes → 16 base64url chars; prefix is 3 chars.
    expect(key).toMatch(/^bk_[A-Za-z0-9_-]{16}$/);
    expect(key.length).toBe(3 + Math.ceil((PUBLIC_KEY_ENTROPY_BYTES * 8) / 6));
  });

  it('generates unique keys', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generatePublicKey()));
    expect(keys.size).toBe(200);
  });
});
