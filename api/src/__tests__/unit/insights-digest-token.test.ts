import { describe, it, expect } from 'vitest';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../../insights/digest-token';

describe('insights · digest unsubscribe token (P3 D6)', () => {
  const tenantId = '6c1f0e2a-1111-4a2b-9c3d-aaaabbbbcccc';

  it('round-trips a tenant id through sign → verify', () => {
    const token = signUnsubscribeToken(tenantId);
    expect(verifyUnsubscribeToken(token)).toBe(tenantId);
  });

  it('rejects a tampered signature', () => {
    const token = signUnsubscribeToken(tenantId);
    const tampered = token.slice(0, -2) + (token.endsWith('00') ? 'ff' : '00');
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it('rejects a swapped-tenant payload (signature is purpose+tenant-bound)', () => {
    const a = signUnsubscribeToken(tenantId);
    const b = signUnsubscribeToken('99999999-2222-4a2b-9c3d-dddd00001111');
    // Splice A's payload onto B's signature — must not verify as either tenant.
    const forged = a.split('.')[0] + '.' + b.split('.')[1];
    expect(verifyUnsubscribeToken(forged)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyUnsubscribeToken('')).toBeNull();
    expect(verifyUnsubscribeToken('no-dot')).toBeNull();
    expect(verifyUnsubscribeToken('.sigonly')).toBeNull();
  });
});
