/**
 * Internal RAG bearer auth, with room to rotate.
 *
 * `RAG_INTERNAL_SECRET` is a platform-level shared secret, and the only way to
 * change it used to be to change it everywhere at once — which is why a leaked
 * secret stayed leaked. Accepting a previous secret for the length of a rotation
 * makes the change a two-step deploy instead of a flag day:
 *
 *   1. set `RAG_INTERNAL_SECRET` to the new value and
 *      `RAG_INTERNAL_SECRET_PREVIOUS` to the old one; deploy.
 *   2. update the callers, then watch the logs for
 *      "authenticated with the PREVIOUS secret". When it stops appearing,
 *      delete `RAG_INTERNAL_SECRET_PREVIOUS`.
 *
 * Every candidate is compared in constant time, and the comparison does not
 * short-circuit on the first match, so the work done does not reveal WHICH secret
 * was sent.
 */
import crypto from 'crypto';

export type RagSecretSource = 'current' | 'previous';

export interface RagSecrets {
  current?: string;
  previous?: string;
}

/** Which secret the header matches, or null. Never throws on a malformed header. */
export function matchRagToken(
  authHeader: string,
  secrets: RagSecrets,
): RagSecretSource | null {
  const candidates: Array<[RagSecretSource, string | undefined]> = [
    ['current', secrets.current],
    ['previous', secrets.previous],
  ];

  let matched: RagSecretSource | null = null;
  for (const [source, secret] of candidates) {
    if (!secret) continue;
    const expected = `Bearer ${secret}`;
    // Length first: `timingSafeEqual` throws when the buffers differ in length.
    const ok =
      authHeader.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
    if (ok) matched = matched ?? source;
  }
  return matched;
}
