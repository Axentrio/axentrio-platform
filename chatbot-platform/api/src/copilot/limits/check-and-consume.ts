/**
 * Orchestrator that runs both Copilot cost checks in order.
 *
 * Per Q10 middleware ordering (called from the route handler AFTER
 * auth + tenant resolution + feature gate + body validation):
 *
 *   1. Daily-cap INCR — increment + check against tenant cap
 *   2. Per-minute rate-limit INCR — increment + check
 *
 * The plan calls this out as deliberate behaviour:
 *
 *   - Counters are consumed for EVERY accepted (auth/feature/body-OK)
 *     request, regardless of agent-loop outcome (LLM error, abort,
 *     agent_loop_exceeded all still leave the counter incremented).
 *
 *   - If the daily-cap check passes but the per-minute reject fires,
 *     the daily counter has already been consumed. v1 accepts that:
 *     the daily counter represents "requests this tenant attempted
 *     today" rather than "requests that ran to completion."
 *
 *   - Throws a typed error per rejected case so the route handler
 *     can map to HTTP 429 with the right `error.code` and the
 *     `Retry-After` header value.
 */
import type Redis from 'ioredis';
import { checkAndConsumeDailyCap, CopilotDailyCapExceededError, getDailyCap } from './daily-cap';
import {
  checkAndConsumeRateLimit,
  CopilotRateLimitExceededError,
  getPerMinuteLimit,
} from './rate-limit';

export interface CopilotCostCheckResult {
  /** Post-INCR daily count; null when Redis is unavailable (fail-open). */
  dailyCount: number | null;
  /** Post-INCR per-minute count; null when Redis is unavailable (fail-open). */
  rateLimitCount: number | null;
}

/**
 * Run both limiters in order. Throws the appropriate typed error
 * on rejection. Returns counters on success — useful for the trace
 * row so operators can see how close a turn came to the cap.
 *
 * The route handler is responsible for HTTP mapping:
 *   - CopilotDailyCapExceededError → 429, `code: 'copilot_daily_cap_exceeded'`,
 *     `Retry-After: <retryAfterSeconds>`
 *   - CopilotRateLimitExceededError → 429, `code: 'copilot_rate_limit_exceeded'`,
 *     `Retry-After: <retryAfterSeconds>`
 */
export async function checkAndConsumeCopilotCost(
  redis: Redis | null,
  tenantId: string,
  userId: string,
  caps: { dailyCap?: number; perMinuteLimit?: number } = {},
): Promise<CopilotCostCheckResult> {
  const dailyCap = caps.dailyCap ?? getDailyCap();
  const perMinuteLimit = caps.perMinuteLimit ?? getPerMinuteLimit();

  // Daily first — `Retry-After` for daily is "seconds until midnight",
  // which is more useful to surface up-front than the 60s rate-limit
  // window if both happen to be over the line.
  const daily = await checkAndConsumeDailyCap(redis, tenantId, dailyCap);
  if (!daily.allowed) {
    throw new CopilotDailyCapExceededError(
      tenantId,
      daily.count ?? -1,
      dailyCap,
      daily.retryAfterSeconds ?? 0,
    );
  }

  const perMinute = await checkAndConsumeRateLimit(redis, tenantId, userId, perMinuteLimit);
  if (!perMinute.allowed) {
    // Daily counter was already consumed above; per plan round 4 #5
    // we explicitly do NOT roll it back.
    throw new CopilotRateLimitExceededError(
      tenantId,
      userId,
      perMinute.count ?? -1,
      perMinuteLimit,
      perMinute.retryAfterSeconds ?? 60,
    );
  }

  return { dailyCount: daily.count, rateLimitCount: perMinute.count };
}
