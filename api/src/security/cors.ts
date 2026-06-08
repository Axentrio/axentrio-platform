/**
 * Shared CORS origin/credentials policy (security audit #D).
 *
 * The key invariant: NEVER combine a wildcard origin (`*`) with credentials —
 * that's the classic credentialed-CORS hole. Credentials are allowed only for
 * explicitly-allowlisted origins (and only when CORS_CREDENTIALS is on). Used by
 * both the Express `cors()` middleware and the Socket.IO server config.
 */
import { config } from '../config/environment';

export function getConfiguredOrigins(): string[] {
  const allowed = (Array.isArray(config.cors.origin) ? config.cors.origin : [config.cors.origin])
    .filter(Boolean) as string[];
  const devOrigins = config.server.isDevelopment
    ? ['http://localhost:4080', 'http://localhost:3000', 'http://localhost:5173', 'http://localhost:8888']
    : [];
  return [...allowed, ...devOrigins];
}

export function isWildcardCors(): boolean {
  return getConfiguredOrigins().includes('*');
}

/** Explicitly-allowlisted origins (preserves the existing Clerk exception). */
export function isOriginAllowed(origin: string): boolean {
  const all = getConfiguredOrigins();
  return all.includes(origin) || origin.endsWith('.clerk.accounts.dev');
}

export interface CorsDecision {
  origin: string | boolean;
  credentials: boolean;
}

/** Resolve per-request CORS — wildcard never yields credentials. */
export function resolveCorsDecision(origin: string | undefined): CorsDecision {
  const wildcard = isWildcardCors();
  if (!origin) return { origin: wildcard ? '*' : true, credentials: false };
  if (isOriginAllowed(origin)) return { origin, credentials: !!config.cors.credentials };
  if (wildcard) return { origin: '*', credentials: false };
  return { origin: false, credentials: false }; // unmatched → no ACAO
}
