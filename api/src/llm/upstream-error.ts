import { RateLimitError } from '../middleware/error-handler';

/**
 * OpenAI / Anthropic SDK errors expose a numeric HTTP `status`. A 429 from the
 * provider means the UPSTREAM is rate-limited (e.g. the org tokens-per-minute
 * cap) — distinct from our own per-tenant cap (LlmRateLimitError). Detect it so
 * callers can surface a clean "busy, try again" 429 instead of a misleading 500
 * ("check your API key and model" / "RAG pipeline failed").
 */
export function isUpstreamRateLimit(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { status?: number; code?: string }).status === 429
  );
}

/** Throw a 429 RateLimitError when `err` is an upstream provider 429; else no-op. */
export function rethrowIfUpstreamRateLimit(err: unknown): void {
  if (isUpstreamRateLimit(err)) {
    throw new RateLimitError(
      'The AI is busy right now (upstream rate limit). Please try again in a moment.',
    );
  }
}
