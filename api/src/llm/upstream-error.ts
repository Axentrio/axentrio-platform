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

/**
 * A provider 5xx: the UPSTREAM had a server-side fault (500, 502, 503, 504...).
 * It is transient - a retry may clear it - and it is a provider problem, not a
 * fault in one conversation. A numeric HTTP status is the reliable tell: our own
 * DB/Redis transport failures carry no `status`, so this never mislabels them.
 */
export function isUpstreamServerError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 500 && status <= 599;
}

/** Node/libuv transport error codes that mean "could not reach the host". */
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED',
]);

/**
 * The provider was UNREACHABLE: a transport failure with no HTTP status (a
 * dropped socket, a DNS miss, a refused connection). The OpenAI/Anthropic SDKs
 * surface this as `APIConnectionError` / `APIConnectionTimeoutError`; the raw
 * cause carries a libuv `code`.
 *
 * CAUTION: apply this ONLY to an error KNOWN to come from the provider call. A
 * bare transport error is indistinguishable from a DB/Redis one by shape alone,
 * so the run-level classifier must NOT call this directly - it reads the typed
 * `UpstreamUnreachableError` instead, which only the provider call site raises.
 */
export function isUpstreamUnreachable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: unknown; name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown } };
  if (typeof e.status === 'number') return false; // an HTTP error, not a transport failure
  const name = typeof e.name === 'string' ? e.name : '';
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;
  const code = typeof e.code === 'string' ? e.code : typeof e.cause?.code === 'string' ? e.cause.code : '';
  if (NETWORK_CODES.has(code)) return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return /socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(msg);
}

/**
 * A transient upstream failure that a single immediate retry may clear: a 429
 * rate limit, a 5xx server error, or an unreachable provider - which INCLUDES the
 * SDK's own `APIConnectionTimeoutError`, a transport-level connect timeout, via
 * `isUpstreamUnreachable`.
 *
 * Two timeouts must not be confused. The SDK connect timeout above is a transport
 * failure and IS retryable. The agent's OWN 30-second `Promise.race` guard is a
 * plain `Error('LLM request timeout after 30s')` - it is NOT matched here and is
 * deliberately not retried, because a second 30-second wait only doubles an
 * already bad latency. A quota-exhausted 429 is also excluded: it will not clear
 * on its own and wants a human to pay an invoice, not a retry.
 */
export function isRetryableUpstream(err: unknown): boolean {
  if (isUpstreamQuotaExhausted(err)) return false;
  return isUpstreamRateLimit(err) || isUpstreamServerError(err) || isUpstreamUnreachable(err);
}

/**
 * Wraps a provider transport failure so the run-level classifier can name it
 * `upstream_unreachable` WITHOUT guessing whether a bare network error came from
 * the provider or from our own datastore. Only the provider call site raises it.
 * The message is the underlying error's own words, so the audit record is intact.
 */
export class UpstreamUnreachableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'UpstreamUnreachableError';
    this.cause = cause;
  }
}
