/**
 * Knowing when travel checking has stopped working.
 *
 * Every other part of this feature makes it correct. This makes its FAILURE visible — and the
 * failure it guards is one the design chose on purpose. When routing cannot answer, the gate
 * falls back to the haversine bounds and the flat gap and keeps taking bookings. That is right,
 * and it is silent: a lapsed trial, an expired card, a revoked key, a 2am quota exhaustion and a
 * genuine Google outage all look identical from outside. Bookings keep flowing, quietly less
 * protected than the owner believes.
 *
 * There is a precedent, and it was written after exactly this: `llm/provider-health.ts` exists
 * because the platform OpenAI key ran out of credit, every tenant's bot stopped answering, and
 * it surfaced when a customer complained to a customer who messaged the founder.
 *
 * NOT KEYED ON `travel_check = 'degraded'`, which is the thing most likely to be built instead.
 * `degraded` is PROVENANCE, not a fault — it is written whenever any constraining leg was
 * settled by the floor rather than by routing, which is the ordinary state of a business whose
 * jobs sit close together. An alarm on it would flag most of a good day. The signal is the
 * structured CAUSE emitted at the point of degradation.
 *
 * THREE MECHANISMS, because the three causes are not the same shape:
 *
 *   - **platform** (no key, API error, malformed answer) — needs corroboration before it means
 *     an outage, and needs POSITIVE evidence before it means recovery. See `travel-health.ts`
 *     for the probe half.
 *   - **tenant** (`cap_exhausted`) and **configuration** (a shared itinerary) — DEFINITE STATES,
 *     notified on first occurrence. A burst threshold is the wrong instrument: the shared-diary
 *     detector fires once, on rekey, so "N in a window" would never fire at all.
 *   - **metrics** (`no_route`, `budget_spent`) — counted, never mailed. One `no_route` is
 *     ordinary; a sustained rate is an upstream or data regression worth seeing.
 */
import { getRedisClient, isRedisAvailable } from '../../config/redis';
import { logger } from '../../utils/logger';

/**
 * What a degradation cause means for whoever has to act.
 *
 * `none` is not "unimportant" — it is "nothing has gone wrong". `settled_by_bounds` is the floor
 * doing its job, and `departed` is a slot that went stale mid-conversation. Treating either as a
 * fault is the #64 lesson in the form it keeps coming back in.
 */
export type CauseClass = 'platform' | 'tenant' | 'configuration' | 'metric' | 'none';

export function classifyCause(cause: string): CauseClass {
  switch (cause) {
    case 'no_api_key':
    case 'api_error':
    case 'malformed_response':
      return 'platform';
    case 'cap_exhausted':
      return 'tenant';
    case 'shared_itinerary':
      return 'configuration';
    // Not faults, but worth a rate. One `no_route` is Google having no route for those
    // coordinates today — a geocode in a canal produces one. A sustained rate across distinct
    // pairs is a regression. `budget_spent` at a high rate means the per-call ceiling is
    // defeating the feature rather than bounding it.
    case 'no_route':
    case 'budget_spent':
      return 'metric';
    default:
      return 'none';
  }
}

/** How long a counted occurrence stays countable. */
const WINDOW_SECONDS = 30 * 60;

/**
 * How many observed platform causes make an outage rather than a bad minute.
 *
 * Only the PLATFORM class has a threshold. Tenant and configuration causes are definite states
 * and notify on the first occurrence — see the file header.
 */
export const PLATFORM_THRESHOLD = 5;

const key = (suffix: string) => `travel:degradation:${suffix}`;

/**
 * Count one occurrence inside the rolling window, and answer the running total.
 *
 * Returns `null` when there is nowhere to count. That is not the same as zero, and the caller
 * must not read it as "below threshold" — an alarm that quietly downgrades itself when the cache
 * is down fails exactly when things are worst.
 */
async function bump(suffix: string): Promise<number | null> {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return null;
  try {
    const k = key(suffix);
    const total = await redis.incr(k);
    // Only on the first write of a window, so the window rolls forward rather than being
    // extended indefinitely by traffic.
    if (total === 1) await redis.expire(k, WINDOW_SECONDS);
    return total;
  } catch (error) {
    logger.warn('[travel-health] could not record a degradation cause', { suffix, error });
    return null;
  }
}

async function readCount(suffix: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return 0;
  try {
    const raw = await redis.get(key(suffix));
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * A routed request ANSWERED.
 *
 * Recorded because a recovery claim needs something affirmative behind it, and nothing else can
 * supply one. An observation-raised incident must never be cleared by a quiet window: silence is
 * what NO BOOKING TRAFFIC looks like, not what recovery looks like, and clearing on it would
 * announce an all-clear that had not happened and oscillate for as long as the real failure
 * lasted. That is worse than silence, because it teaches the operator the alarm is noise.
 */
export async function recordRoutingSuccess(): Promise<void> {
  await bump('success');
}

/** Successes seen inside the window — the positive evidence an observed recovery needs. */
export function routingSuccesses(): Promise<number> {
  return readCount('success');
}

/** Observed platform-class failures inside the window. */
export function platformFailures(): Promise<number> {
  return readCount('platform');
}

/** Rates that are watched but never mailed (see the header). */
export async function metricCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const cause of ['no_route', 'budget_spent']) out[cause] = await readCount(`metric:${cause}`);
  return out;
}

/**
 * Record one degradation cause seen during real work.
 *
 * Never throws: a monitor that can break a booking is worse than the blindness it cures.
 */
export async function recordCause(cause: string): Promise<void> {
  const cls = classifyCause(cause);
  if (cls === 'none') return;
  if (cls === 'metric') {
    await bump(`metric:${cause}`);
    return;
  }
  if (cls === 'platform') {
    const total = await bump('platform');
    if (total !== null && total === PLATFORM_THRESHOLD) {
      logger.error('[travel-health] sustained platform degradation observed in real traffic', {
        cause,
        occurrences: total,
        windowMinutes: WINDOW_SECONDS / 60,
      });
    }
  }
  // Tenant and configuration causes carry an identity and are notified by their own callers —
  // an alert that names no one who can act is not an alert. See `recordScopedCause`.
}

/** Reset between tests. Production never calls this. */
export async function __resetDegradationCounters(): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return;
  const keys = await redis.keys(key('*'));
  if (keys.length) await redis.del(...keys);
}
