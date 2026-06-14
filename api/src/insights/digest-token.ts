/**
 * Signed one-click unsubscribe tokens for the weekly digest (P3 / ADR-0014 D6).
 *
 * The token is stateless: `base64url(tenantId).hmac` where the HMAC is over a
 * purpose-scoped payload so a digest-unsubscribe link can't be replayed against
 * any other signing surface. No DB lookup is needed to validate — the link in
 * an email a year old still verifies, and revocation is just flipping the pref.
 */
import { generateHmac, verifyHmac } from '../utils/encryption';
import { config } from '../config/environment';

const PURPOSE = 'digest-unsub';

function payload(tenantId: string): string {
  return `${PURPOSE}:${tenantId}`;
}

export function signUnsubscribeToken(tenantId: string): string {
  const sig = generateHmac(payload(tenantId), config.encryption.key);
  return `${Buffer.from(tenantId).toString('base64url')}.${sig}`;
}

/** Returns the tenantId iff the token is well-formed and the HMAC verifies. */
export function verifyUnsubscribeToken(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  let tenantId: string;
  try {
    tenantId = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sig = token.slice(dot + 1);
  if (!tenantId || !sig) return null;
  return verifyHmac(payload(tenantId), sig, config.encryption.key) ? tenantId : null;
}
