/**
 * Per-tenant daily LLM call rate limit.
 *
 * Why: OpenAI is the only variable cost in the stack. A runaway integration
 * or abusive widget user could 10x the bill overnight. This caps each tenant
 * to a configurable daily call count.
 *
 * Storage: Redis INCR on `llm_rate:{tenantId}:{YYYY-MM-DD}` with a 24h TTL.
 *
 * Limit source (in order — plan step 10, gate 1):
 *   1. Caller-supplied `perTenantOverride` (explicit numeric override; used
 *      by tests AND legacy callers that pre-resolved the cap themselves).
 *   2. `getEntitlements(tenantId).limits.dailyLlmCalls` — the v1 source of
 *      truth, which already merges Enterprise per-tenant overrides on top
 *      of plan defaults (Free: 0 → BLOCK every call; Pro: 1000; Premium:
 *      10000; Enterprise: null → unlimited unless override set).
 *   3. `config.llmRateLimit.dailyLimitPerTenant` — final env fallback if the
 *      DB lookup itself fails (e.g. transient connection drop). Keeps the
 *      product from hard-locking when entitlements can't be read.
 *
 * Fail-open: if Redis is unreachable, we ALLOW the call (mirrors widget.routes
 * in-memory fallback precedent). We do not block a paying customer's chat just
 * because Redis hiccupped.
 *
 * The 429 response shape is produced by LlmRateLimitError → ApiError handler:
 *   { error: 'daily_llm_limit_reached', limit, used }
 */

import type Redis from 'ioredis';
import { getRedisClient, isRedisAvailable } from '../config/redis';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { ApiError } from '../middleware/error-handler';
import { getEntitlements } from '../billing/entitlements';

/**
 * Thrown when a tenant has consumed its daily LLM call budget.
 * Bubbles up to the global Express errorHandler which serializes ApiError
 * subclasses into the standard error response with HTTP 429.
 *
 * The response body shape (set via ApiError.details + a top-level `error`
 * field that the controller layer can also use directly) is:
 *   { error: 'daily_llm_limit_reached', limit, used }
 */
export class LlmRateLimitError extends ApiError {
  public readonly limit: number;
  public readonly used: number;

  constructor(limit: number, used: number) {
    super(
      'Daily LLM call limit reached for this tenant.',
      429,
      'daily_llm_limit_reached',
      { limit, used }
    );
    this.limit = limit;
    this.used = used;
    Object.setPrototypeOf(this, LlmRateLimitError.prototype);
  }

  /**
   * The exact response body shape required by the spec.
   * Controllers that catch this directly can `res.status(429).json(err.toResponseBody())`.
   * Otherwise the global errorHandler returns the standard ApiError envelope
   * with the same `code`, `statusCode` and `details`.
   */
  toResponseBody(): { error: string; limit: number; used: number } {
    return { error: 'daily_llm_limit_reached', limit: this.limit, used: this.used };
  }
}

/** UTC date key — keeps counters aligned regardless of server timezone. */
function todayUtcKey(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function redisKey(tenantId: string, dateKey = todayUtcKey()): string {
  return `llm_rate:${tenantId}:${dateKey}`;
}

/**
 * Resolve the effective daily cap for a tenant (legacy sync path used by
 * tests and callers that pre-resolved the override). Source: explicit
 * override → env default. v1 production callers should prefer
 * `resolveLimitFromEntitlements` so the cap tracks plan changes.
 */
export function resolveLimit(perTenantOverride?: number | null): number {
  if (typeof perTenantOverride === 'number' && perTenantOverride > 0) {
    return perTenantOverride;
  }
  return config.llmRateLimit.dailyLimitPerTenant;
}

/**
 * Resolve the effective daily cap for a tenant via the plan catalog.
 * Returns:
 *   - `null` when the tenant's plan has no cap (Enterprise unless override),
 *   - a positive number when a finite cap applies,
 *   - `0` to BLOCK every call (Free tier — no platform LLM access).
 *
 * Falls back to the env default if the entitlements lookup itself throws
 * (e.g. transient DB outage) — fails open on infra issues, same precedent
 * as the Redis fail-open path below.
 */
export async function resolveLimitFromEntitlements(
  tenantId: string,
): Promise<number | null> {
  try {
    const ent = await getEntitlements(tenantId);
    return ent.limits.dailyLlmCalls; // null | 0 | positive
  } catch (err) {
    logger.warn('llm_rate_limit_entitlements_lookup_failed_fallback_to_env', {
      tenantId,
      err: err instanceof Error ? err.message : String(err),
    });
    return config.llmRateLimit.dailyLimitPerTenant;
  }
}

/**
 * Increment the tenant's daily counter and enforce the cap.
 *
 * Throws {@link LlmRateLimitError} when the cap is reached.
 * Fails open on any Redis error (logged as warn).
 *
 * @param tenantId Tenant UUID.
 * @param perTenantOverride Optional override from Tenant.dailyLlmCallLimit.
 * @param deps Test seam — inject a Redis client; defaults to the app singleton.
 */
export async function checkAndIncrement(
  tenantId: string,
  perTenantOverride?: number | null,
  deps?: { client?: Redis | null; available?: boolean }
): Promise<{ allowed: true; limit: number | null; used: number }> {
  // Limit resolution order:
  //   - explicit numeric override wins (test seam + legacy pre-resolved cap)
  //   - otherwise consult entitlements (DB lookup; tier + Enterprise override)
  // Entitlements may return null (unlimited) — preserved through the return.
  // Entitlements may return 0 (Free tier) — BLOCK every call without touching Redis.
  let limit: number | null;
  if (typeof perTenantOverride === 'number' && perTenantOverride > 0) {
    limit = perTenantOverride;
  } else {
    limit = await resolveLimitFromEntitlements(tenantId);
  }

  if (limit === 0) {
    // Tier doesn't include platform LLM access. No Redis spin needed.
    logger.warn('llm_rate_limited_zero_quota', { tenantId });
    throw new LlmRateLimitError(0, 0);
  }

  const client = deps?.client !== undefined ? deps.client : getRedisClient();
  const available = deps?.available !== undefined ? deps.available : isRedisAvailable();

  if (!client || !available) {
    // Fail open: Redis unavailable. Don't punish customer chat for our infra hiccup.
    logger.warn('llm_rate_limit_redis_unavailable_failing_open', { tenantId });
    return { allowed: true, limit, used: 0 };
  }

  const key = redisKey(tenantId);
  let used: number;
  try {
    // Atomic increment. EXPIRE on first hit so the counter naturally resets
    // ~24h after the first call of the day.
    used = await client.incr(key);
    if (used === 1) {
      // Best-effort TTL set; if it fails, the next increment retries via the
      // same code path. We intentionally do NOT await separately from incr
      // beyond awaiting here because pipelining isn't worth the complexity.
      await client.expire(key, 86400);
    }
  } catch (err) {
    logger.warn('llm_rate_limit_redis_error_failing_open', {
      tenantId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { allowed: true, limit, used: 0 };
  }

  if (limit !== null && used > limit) {
    // Only log on breach — never on every call.
    logger.warn('llm_rate_limited', { tenantId, limit, used });
    throw new LlmRateLimitError(limit, used);
  }

  return { allowed: true, limit, used };
}

// Re-export key shape for tests.
export const __test = { todayUtcKey, redisKey };
