/**
 * Per-user-per-minute rate limit for Copilot message sends.
 *
 * Redis key: `copilot:rl:{tenantId}:{userId}` (no date suffix — TTL
 * IS the window).
 * Pipeline:
 *
 *     MULTI
 *     INCR copilot:rl:{tenantId}:{userId}
 *     EXPIRE copilot:rl:{tenantId}:{userId} 60
 *     EXEC
 *
 * Sliding-window semantics: EXPIRE on every increment resets the TTL,
 * so 11 calls inside 60s all see the running counter. Close enough to
 * a true sliding window for v1 rate limiting; v1.1 may move to a
 * Lua-script-backed leaky bucket if the loose semantics matter.
 *
 * Fail-open on Redis errors (same Q10 policy as the daily cap —
 * rate-limiting is a UX feature, not a security boundary).
 *
 * Counter consumption rule mirrors `checkAndConsumeDailyCap`: every
 * accepted-by-auth-and-feature-gate request consumes one slot;
 * failed agent turns still count.
 */
import type Redis from 'ioredis';
import { logger } from '../../utils/logger';

export interface RateLimitResult {
  allowed: boolean;
  count: number | null; // null on Redis fail-open
  /** Window-remaining seconds; populated only when `allowed=false`. */
  retryAfterSeconds: number | null;
}

const DEFAULT_PER_MINUTE_LIMIT = 10;
const WINDOW_SECONDS = 60;

export function getPerMinuteLimit(): number {
  const raw = process.env.COPILOT_PER_USER_PER_MINUTE_LIMIT;
  if (!raw) return DEFAULT_PER_MINUTE_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `COPILOT_PER_USER_PER_MINUTE_LIMIT must be a positive integer, got '${raw}'`,
    );
  }
  return parsed;
}

export function buildRateKey(tenantId: string, userId: string): string {
  return `copilot:rl:${tenantId}:${userId}`;
}

export async function checkAndConsumeRateLimit(
  redis: Redis | null,
  tenantId: string,
  userId: string,
  limit: number = getPerMinuteLimit(),
): Promise<RateLimitResult> {
  if (!redis) {
    logger.warn('Copilot rate-limit: Redis client unavailable, failing open', {
      tenantId,
      userId,
    });
    return { allowed: true, count: null, retryAfterSeconds: null };
  }

  const key = buildRateKey(tenantId, userId);

  let results: Array<[Error | null, unknown]> | null;
  try {
    results = (await redis.multi().incr(key).expire(key, WINDOW_SECONDS).exec()) as Array<
      [Error | null, unknown]
    > | null;
  } catch (err) {
    logger.warn('Copilot rate-limit: MULTI/EXEC threw, failing open', {
      tenantId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: true, count: null, retryAfterSeconds: null };
  }

  if (!results) {
    logger.warn('Copilot rate-limit: MULTI/EXEC returned null (txn aborted), failing open', {
      tenantId,
      userId,
    });
    return { allowed: true, count: null, retryAfterSeconds: null };
  }

  const [incr, expire] = results;
  if (incr[0] || expire[0]) {
    logger.warn('Copilot rate-limit: pipeline command error, failing open', {
      tenantId,
      userId,
      incrError: incr[0]?.message,
      expireError: expire[0]?.message,
    });
    return { allowed: true, count: null, retryAfterSeconds: null };
  }

  const count = typeof incr[1] === 'number' ? incr[1] : Number(incr[1]);
  if (!Number.isFinite(count)) {
    logger.warn('Copilot rate-limit: non-numeric INCR result, failing open', {
      tenantId,
      userId,
      raw: incr[1],
    });
    return { allowed: true, count: null, retryAfterSeconds: null };
  }

  if (count <= limit) {
    return { allowed: true, count, retryAfterSeconds: null };
  }
  return { allowed: false, count, retryAfterSeconds: WINDOW_SECONDS };
}

export class CopilotRateLimitExceededError extends Error {
  readonly code = 'copilot_rate_limit_exceeded';
  constructor(
    readonly tenantId: string,
    readonly userId: string,
    readonly count: number,
    readonly limit: number,
    readonly retryAfterSeconds: number,
  ) {
    super(
      `Copilot per-minute rate limit exceeded for tenant ${tenantId}, user ${userId}: ${count}/${limit}. ` +
        `Retry after ${retryAfterSeconds}s.`,
    );
    this.name = 'CopilotRateLimitExceededError';
  }
}
