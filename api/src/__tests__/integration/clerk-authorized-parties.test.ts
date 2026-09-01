import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { verifyJwt } from '@clerk/backend/jwt';
import { clerkMiddlewareOptions } from '../../config/clerk-authorized-parties';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signAzp(azp: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { azp, sub: 'user_test', iat: now, exp: now + 120 },
    privatePem,
    { algorithm: 'RS256', header: { typ: 'JWT', alg: 'RS256' } },
  );
}

describe('Clerk verifyJwt authorizedParties', () => {
  const parties = clerkMiddlewareOptions(['https://staging.axentrio.com'])!.authorizedParties;
  const opts = { key: publicPem, authorizedParties: parties };

  it('allows azp https://staging.axentrio.com', async () => {
    const payload = await verifyJwt(signAzp('https://staging.axentrio.com'), opts);
    expect(payload.azp).toBe('https://staging.axentrio.com');
  });

  it('rejects azp https://app.axentrio.com', async () => {
    await expect(
      verifyJwt(signAzp('https://app.axentrio.com'), opts),
    ).rejects.toMatchObject({
      reason: 'token-invalid-authorized-parties',
    });
  });

  it('rejects azp https://dev.axentrio.com', async () => {
    await expect(
      verifyJwt(signAzp('https://dev.axentrio.com'), opts),
    ).rejects.toMatchObject({
      reason: 'token-invalid-authorized-parties',
    });
  });
});
