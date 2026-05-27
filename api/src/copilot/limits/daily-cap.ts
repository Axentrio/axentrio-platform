/**
 * Daily message cap per tenant.
 *
 * Redis key: `copilot:daily:{tenantId}:{YYYY-MM-DD}` (UTC date)
 * Pipeline:
 *
 *     MULTI
 *     INCR copilot:daily:{tenantId}:{date}
 *     EXPIRE copilot:daily:{tenantId}:{date} 90000     -- ~25h, covers TZ fuzz
 *     EXEC
 *
 * `MULTI`/`EXEC` runs the INCR + EXPIRE atomically as a transaction.
 * EXPIRE happens on every increment — cheap and means the key never
 * lingers forever if a process crashed between INCR and EXPIRE in
 * the pre-atomic past.
 *
 * Returns the post-INCR value AND whether the increment was allowed
 * (post-INCR ≤ cap). The agent loop reads the boolean; the trace
 * logger reads the counter. If Redis errored at any point in the
 * pipeline (transaction abort, per-command error, connection drop)
 * the limiter falls open per Q10 — the cost cap is a UX feature, not
 * a security boundary, and a Redis outage shouldn't lock Pro users
 * out for the duration.
 *
 * Counter consumption rule (plan round 5 #1): every authenticated +
 * feature-gated + body-validated request consumes from this counter
 * BEFORE the agent loop runs. A turn that subsequently errors
 * (OpenAI 5xx, abort, agent-loop timeout) still leaves the counter
 * incremented — the user has "used up" a quota slot.
 *
 * No rollback if the per-minute limiter rejects after this one
 * passes (plan round 4 #5). Cleanest mental model: every accepted
 * request consumes; the per-minute reject still incremented daily.
 */
import type Redis from 'ioredis';
import { logger } from '../../utils/logger';

export interface DailyCapResult {
  allowed: boolean;
  count: number | null; // null on Redis fail-open
  /** Seconds until midnight UTC; populated only when `allowed=false`. */
  retryAfterSeconds: number | null;
}

const DEFAULT_DAILY_CAP = 50;
const EXPIRE_SECONDS = 90_000; // ~25h, covers UTC day rollover + clock fuzz

export function getDailyCap(): number {
  const raw = process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT;
  if (!raw) return DEFAULT_DAILY_CAP;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `COPILOT_DAILY_MESSAGE_CAP_PER_TENANT must be a positive integer, got '${raw}'`,
    );
  }
  return parsed;
}

export function buildDailyKey(tenantId: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `copilot:daily:${tenantId}:${yyyy}-${mm}-${dd}`;
}

export function secondsUntilNextUtcMidnight(now: Date = new Date()): number {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return Math.max(0, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

/**
 * Increment-and-check the daily cap for `tenantId`. Atomic via
 * MULTI/EXEC. Inspects BOTH command results — any pipeline error
 * is treated as Redis-unavailable per Q10 fail-open policy.
 *
 * @param redis the active ioredis client (or null if Redis isn't
 *              initialised — caller falls open)
 * @param tenantId the calling tenant
 * @param cap     daily cap (default from env / 50)
 */
export async function checkAndConsumeDailyCap(
  redis: Redis | null,
  tenantId: string,
  cap: number = getDailyCap(),
  now: Date = new Date(),
): Promise<DailyCapResult> {
  if (!redis) {
    logger.warn('Copilot daily-cap: Redis client unavailable, failing open', { tenantId });
    return { allowed: true, count: null, retryAfterSeconds: null };
  }

  const key = buildDailyKey(tenantId, now);

  let results: Array<[Error | null, unknown]> | null;
  try {
    results = (await redis.multi().incr(key).expire(key, EXPIRE_SECONDS).exec()) as Array<
      [Error | null, unknown]
    > | null;
  } catch (err) {
    logger.warn('Copilot daily-cap: MULTI/EXEC threw, failing open', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: true, count: null, retryAfterSeconds: null };
  }

  if (!results) {
    logger.warn('Copilot daily-cap: MULTI/EXEC returned null (txn aborted), failing open', {
      tenantId,
    });
    return { allowed: true, count: null, retryAfterSeconds: null };
  }

  const [incr, expire] = results;
  if (incr[0] || expire[0]) {
    logger.warn('Copilot daily-cap: pipeline command error, failing open', {
      tenantId,
      incrError: incr[0]?.message,
      expireError: expire[0]?.message,
    });
    return { allowed: true, count: null, retryAfterSeconds: null };
  }

  const count = typeof incr[1] === 'number' ? incr[1] : Number(incr[1]);
  if (!Number.isFinite(count)) {
    logger.warn('Copilot daily-cap: non-numeric INCR result, failing open', {
      tenantId,
      raw: incr[1],
    });
    return { allowed: true, count: null, retryAfterSeconds: null };
  }

  if (count <= cap) {
    return { allowed: true, count, retryAfterSeconds: null };
  }
  return {
    allowed: false,
    count,
    retryAfterSeconds: secondsUntilNextUtcMidnight(now),
  };
}

/**
 * Typed error thrown by the orchestrator when the daily cap is hit.
 * The route handler maps this to HTTP 429 with `Retry-After`.
 */
export class CopilotDailyCapExceededError extends Error {
  readonly code = 'copilot_daily_cap_exceeded';
  constructor(
    readonly tenantId: string,
    readonly count: number,
    readonly cap: number,
    readonly retryAfterSeconds: number,
  ) {
    super(
      `Copilot daily cap exceeded for tenant ${tenantId}: ${count}/${cap}. ` +
        `Retry after ${retryAfterSeconds}s.`,
    );
    this.name = 'CopilotDailyCapExceededError';
  }
}
