/**
 * Knowing when travel checking has stopped working.
 *
 * Every other part of this feature makes it correct. This makes its FAILURE visible - and the
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
 * `degraded` is PROVENANCE, not a fault - it is written whenever any constraining leg was
 * settled by the floor rather than by routing, which is the ordinary state of a business whose
 * jobs sit close together. An alarm on it would flag most of a good day. The signal is the
 * structured CAUSE emitted at the point of degradation.
 *
 * THREE MECHANISMS, because the three causes are not the same shape:
 *
 *   - **platform** (no key, API error, malformed answer) - needs corroboration before it means
 *     an outage, and needs POSITIVE evidence before it means recovery. See `travel-health.ts`
 *     for the probe half.
 *   - **tenant** (`cap_exhausted`) and **configuration** (a shared itinerary) - DEFINITE STATES,
 *     notified to that tenant on first occurrence. A burst threshold is the wrong instrument:
 *     the shared-diary detector fires once, on rekey, so "N in a window" would never fire at all.
 *     They are ALSO aggregated for the operator, by DISTINCT IDENTITY, because twenty tenants
 *     exhausting their cap in one afternoon is a pricing misjudgement rather than twenty
 *     coincidences - and one busy capped tenant must not be able to look like that.
 *   - **metrics** (`no_route`, `budget_spent`) - counted, never mailed. One `no_route` is
 *     ordinary; a sustained rate is an upstream or data regression worth seeing.
 *
 * ORDERING COMES FROM REDIS, NOT FROM CLOCKS. Deciding whether a success came AFTER the last
 * failure is the whole of the recovery rule, and the two events are recorded by whichever
 * instance handled each request. Comparing wall-clock stamps across hosts would make a recovery
 * claim depend on clock skew, so every outcome takes a number from one shared counter instead.
 */
import { getRedisClient, isRedisAvailable } from '../../config/redis';
import { logger } from '../../utils/logger';

/**
 * What a degradation cause means for whoever has to act.
 *
 * `none` is not "unimportant" - it is "nothing has gone wrong". `settled_by_bounds` is the floor
 * doing its job, and `departed` is a slot that went stale mid-conversation. Treating either as a
 * fault is the #64 lesson in the form it keeps coming back in.
 */
export type CauseClass = 'platform' | 'tenant' | 'configuration' | 'metric' | 'none';

/**
 * EVERY cause this system can report, and what each one means.
 *
 * This map is the reason #93 cannot happen twice. That bug was not a wrong classification, it was
 * a MISSING one: `places.service` reported `places_api_error`, `classifyCause` had no case for it,
 * and a `default: 'none'` discarded every report for months. A default arm is a silent accept-all,
 * and the thing it silently accepted was the only evidence that address suggestions had never
 * worked in production.
 *
 * So there is no default arm any more, and no switch. A cause is a key of this map or it does not
 * type-check - which means the failure moves from "an alert never fires, and nobody learns why for
 * months" to "the build goes red on the line that introduced it".
 *
 * THE MAP ALONE PROVES NOTHING. It only closes the hole if every producer is typed as
 * `DegradationCause` rather than `string`: `RoutedLeg.cause`, the gate's cause set,
 * `degradedCauses`, and the routes client's own union. A single surviving `string` boundary
 * re-opens it, because a `string` still assigns to a key-typed parameter nowhere but does flow
 * through any collector still typed loosely. And it is only OBSERVED by `tsc`, never by the test
 * suite - vitest does not type-check.
 *
 * `none` is not "unimportant", it is "nothing has gone wrong", and the entries carrying it are the
 * point of writing them down: each was a deliberate decision that now has to be deleted rather
 * than merely forgotten.
 */
export const CAUSE_CLASS = {
  // Platform: needs corroboration before it means an outage, and positive evidence before it means
  // recovery. See `travel-health.ts` for the probe half.
  no_api_key: 'platform',
  api_error: 'platform',
  malformed_response: 'platform',

  // ADDRESS SUGGESTIONS FAIL THE SAME WAY THE GATE DOES, and used to be counted nowhere.
  //
  // Places API (New) was never enabled on the production project, so EVERY autocomplete since
  // launch returned `api_error` - and the fail-open turns that into a 200 with an empty list,
  // indistinguishable from a query that matched nothing. Silent at the surface by design, silent
  // in the monitor by accident. Classed exactly like their gate equivalents.
  places_api_error: 'platform',
  places_cap_exhausted: 'tenant',

  // Definite states, notified to the tenant on first occurrence rather than on a threshold.
  cap_exhausted: 'tenant',
  shared_itinerary: 'configuration',

  // Not faults, but worth a rate. One `no_route` is Google having no route for those coordinates
  // today - a geocode in a canal produces one. A sustained rate across distinct pairs is a
  // regression. `budget_spent` at a high rate means the per-call ceiling is defeating the feature
  // rather than bounding it.
  no_route: 'metric',
  budget_spent: 'metric',

  // An unexplained degradation, and the one entry that CHANGED when this map replaced the switch.
  //
  // `travel-gate` invents this when a lookup returns null minutes and names no cause. Under the
  // old `default: 'none'` it was discarded - which is #93's exact shape sitting inside the fix for
  // #93: the one cause meaning "something failed and we do not know what" was the one guaranteed
  // to be counted nowhere. A rate is the least it can be worth.
  unknown: 'metric',

  // Not faults, and each of these is a decision rather than an oversight. `settled_by_bounds` is
  // the floor doing its job and would flag most of a good day (#64). `departed` is a slot that went
  // stale mid-conversation. `not_cached` is a cache-only read declining to buy a measurement, and
  // `routes.service` says so where it is produced. `estimated` is geometry answering instead of
  // roads, which may rank but never refuse.
  settled_by_bounds: 'none',
  departed: 'none',
  not_cached: 'none',
  estimated: 'none',
} as const satisfies Record<string, CauseClass>;

/**
 * Every cause the system can report.
 *
 * Derived from the map rather than declared beside it, because two declarations drift and one
 * cannot. Producers are typed with THIS, which is what turns a new unclassified cause into a
 * compile error instead of a silent `none`.
 */
export type DegradationCause = keyof typeof CAUSE_CLASS;

export function classifyCause(cause: DegradationCause): CauseClass {
  return CAUSE_CLASS[cause];
}

/** How long a counted occurrence stays countable. */
const WINDOW_SECONDS = 30 * 60;

/**
 * How many observed platform causes make an outage rather than a bad minute.
 *
 * Only the PLATFORM class has a threshold. Tenant and configuration causes are definite states
 * and notify on the first occurrence - see the file header.
 */
export const PLATFORM_THRESHOLD = 5;

const key = (suffix: string) => `travel:degradation:${suffix}`;

/**
 * Whether the monitor can currently see anything at all.
 *
 * `unknown` is a THIRD ANSWER and it has to exist. Redis holds every counter, every latch and the
 * ordering; without it the honest report is "monitoring is degraded", not zero failures and no
 * incident. Returning zero would fabricate health at exactly the moment the monitor went blind,
 * which is this ticket's own defect one layer up.
 */
export type MonitorState = 'ok' | 'unknown';

function redisOrNull() {
  const redis = getRedisClient();
  return redis && isRedisAvailable() ? redis : null;
}

/**
 * Best-effort counting while Redis is away, so a short blip does not erase the evidence.
 *
 * BOUNDED on purpose, and per process: this is a shock absorber, not a store. It cannot
 * deduplicate across instances and it does not survive a restart, so nothing may claim
 * cross-instance ordering or recovery from it - which is what `monitorState` exists to say.
 */
const FALLBACK_CAP = 1000;
const fallbackCounts = new Map<string, number>();

function bumpFallback(suffix: string): void {
  const current = fallbackCounts.get(suffix) ?? 0;
  if (current >= FALLBACK_CAP) return;
  fallbackCounts.set(suffix, current + 1);
}

/**
 * Count one occurrence inside the rolling window, and answer the running total.
 *
 * Returns `null` when there is nowhere to count. That is not the same as zero, and the caller
 * must not read it as "below threshold" - an alarm that quietly downgrades itself when the cache
 * is down fails exactly when things are worst. `monitorState()` is how a reader tells them apart.
 */
async function bump(suffix: string): Promise<number | null> {
  const redis = redisOrNull();
  if (!redis) {
    bumpFallback(suffix);
    return null;
  }
  try {
    const k = key(suffix);
    const total = await redis.incr(k);
    // Only on the first write of a window, so the window rolls forward rather than being
    // extended indefinitely by traffic.
    if (total === 1) await redis.expire(k, WINDOW_SECONDS);
    return total;
  } catch (error) {
    bumpFallback(suffix);
    logger.warn('[travel-health] could not record a degradation cause', { suffix, error });
    return null;
  }
}

async function readCount(suffix: string): Promise<number> {
  const redis = redisOrNull();
  if (!redis) return fallbackCounts.get(suffix) ?? 0;
  try {
    const raw = await redis.get(key(suffix));
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return fallbackCounts.get(suffix) ?? 0;
  }
}

/** Can the monitor currently be believed? */
export async function monitorState(): Promise<MonitorState> {
  const redis = redisOrNull();
  if (!redis) return 'unknown';
  try {
    await redis.get(key('platform'));
    return 'ok';
  } catch {
    return 'unknown';
  }
}

/**
 * The order events happened in, assigned by ONE authority.
 *
 * Recovery means "a routed request answered AFTER the last failure", and the two events come from
 * different instances. A shared monotonic counter makes that comparison hold without trusting any
 * host's clock; `null` means the ordering is unknowable right now, and a recovery must not be
 * claimed from it.
 */
async function stampSequence(which: 'failure' | 'success'): Promise<void> {
  const redis = redisOrNull();
  if (!redis) return;
  try {
    const seq = await redis.incr(key('seq'));
    await redis.set(key(`last:${which}`), String(seq));
  } catch (error) {
    logger.warn('[travel-health] could not stamp an outcome sequence', { which, error });
  }
}

async function readSequence(which: 'failure' | 'success'): Promise<number> {
  const redis = redisOrNull();
  if (!redis) return 0;
  try {
    const raw = await redis.get(key(`last:${which}`));
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * Has a routed request answered SINCE the last one failed?
 *
 * The only honest basis for an observation-raised recovery. A quiet window proves nothing -
 * silence is what no booking traffic looks like - and a raw success COUNT proves nothing either,
 * because one success at the start of a window says nothing about twenty failures after it.
 */
export async function routingRecoveredSinceLastFailure(): Promise<boolean> {
  const [lastSuccess, lastFailure] = await Promise.all([readSequence('success'), readSequence('failure')]);
  return lastSuccess > 0 && lastSuccess > lastFailure;
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
  await stampSequence('success');
}

/** Successes seen inside the window. A rate, not the recovery test - see the function above. */
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

async function addToSpread(suffix: string, member: string): Promise<void> {
  const redis = redisOrNull();
  if (!redis) return;
  try {
    const k = key(`spread:${suffix}`);
    await redis.sadd(k, member);
    await redis.expire(k, WINDOW_SECONDS);
  } catch (error) {
    logger.warn('[travel-health] could not record a scoped cause', { suffix, error });
  }
}

/**
 * How many DISTINCT tenants and configurations are affected right now.
 *
 * Distinct identities rather than occurrences, because the question the operator is asking is
 * "is this platform-wide", and raw counts cannot answer it: one busy tenant at its cap emits an
 * event per booking and would look like an epidemic, while twenty tenants hitting theirs once
 * each - the pattern actually worth seeing - would look like nothing.
 *
 * Deliberately NO ALERT attached. With the feature inert there is no baseline, so any threshold
 * invented here would be a guess dressed as a rule.
 */
export async function scopedCauseSpread(): Promise<{ capExhaustedTenants: number; sharedItineraryBots: number }> {
  const redis = redisOrNull();
  if (!redis) return { capExhaustedTenants: 0, sharedItineraryBots: 0 };
  const size = async (suffix: string): Promise<number> => {
    try {
      return await redis.scard(key(`spread:${suffix}`));
    } catch {
      return 0;
    }
  };
  const [capExhaustedTenants, sharedItineraryBots] = await Promise.all([
    size('cap_exhausted'),
    size('shared_itinerary'),
  ]);
  return { capExhaustedTenants, sharedItineraryBots };
}

/**
 * Record one degradation cause seen during real work.
 *
 * `scope` carries the identity a tenant-or-configuration cause belongs to. Without it the
 * operator aggregate cannot count DISTINCT affected parties, which is the only counting that
 * answers "is this platform-wide".
 *
 * Never throws: a monitor that can break a booking is worse than the blindness it cures.
 */
export async function recordCause(cause: DegradationCause, scope?: { tenantId?: string; botId?: string }): Promise<void> {
  const cls = classifyCause(cause);
  if (cls === 'none') return;

  if (cls === 'metric') {
    await bump(`metric:${cause}`);
    return;
  }

  if (cls === 'platform') {
    // Stamped BEFORE the count, so a reader that sees the threshold crossed also sees the failure
    // ordered after any earlier success.
    await stampSequence('failure');
    const total = await bump('platform');
    if (total !== null && total === PLATFORM_THRESHOLD) {
      logger.error('[travel-health] sustained platform degradation observed in real traffic', {
        cause,
        occurrences: total,
        windowMinutes: WINDOW_SECONDS / 60,
      });
    }
    return;
  }

  // Tenant and configuration causes are notified to the party who can act by their own callers -
  // an alert that names no one who can act is not an alert. What happens here is the operator
  // half: how WIDE the problem is, counted by distinct identity.
  if (cls === 'tenant' && scope?.tenantId) await addToSpread(cause, scope.tenantId);
  if (cls === 'configuration' && scope?.tenantId) {
    await addToSpread(cause, `${scope.tenantId}:${scope.botId ?? 'unknown'}`);
  }
}

/** Reset between tests. Production never calls this. */
export async function __resetDegradationCounters(): Promise<void> {
  fallbackCounts.clear();
  const redis = redisOrNull();
  if (!redis) return;
  const keys = await redis.keys(key('*'));
  if (keys.length) await redis.del(...keys);
}
