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

/**
 * A 429 that will NEVER clear on its own: the account is out of credit or over
 * its billing quota. OpenAI returns these as 429 alongside genuine rate limits,
 * but they are opposites operationally — a rate limit wants a retry, an
 * exhausted balance wants a human to pay an invoice.
 *
 * Conflating them is not academic. On 2026-08-03 the platform key hit
 * `credit_balance_exhausted`; every tenant's AI was down and the failure looked
 * like ordinary busyness, so nothing alerted and it surfaced only when a customer
 * complained over Telegram. We cannot even say how long it lasted — only when a
 * human noticed.
 *
 * Matches on the provider's own error code rather than message text, which is
 * copy that changes without notice.
 */
const QUOTA_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'billing_hard_limit_reached',
]);

export function isUpstreamQuotaExhausted(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; type?: unknown; error?: { code?: unknown; type?: unknown } };
  // The SDK surfaces the code at the top level; the raw HTTP body nests it under
  // `error`. Check both so this holds whichever the caller happens to hand us.
  for (const v of [e.code, e.type, e.error?.code, e.error?.type]) {
    if (typeof v === 'string' && QUOTA_CODES.has(v)) return true;
  }
  return false;
}

/** Throw a 429 RateLimitError when `err` is an upstream provider 429; else no-op. */
export function rethrowIfUpstreamRateLimit(err: unknown): void {
  if (isUpstreamRateLimit(err)) {
    throw new RateLimitError(
      'The AI is busy right now (upstream rate limit). Please try again in a moment.',
    );
  }
}
