/**
 * How long is the drive? The one place that asks Google Routes.
 *
 * WHAT THIS IS FOR. The two haversine bounds in `contracts/travel.ts` settle a pair only
 * when it is absurdly close or absurdly far. Everything between them is opinion, and until
 * this existed that opinion was "capture it as a Request and let the owner decide". Live
 * measurement of Belgian pairs put roughly four in five realistic neighbour checks in that
 * band, so the middle was not an edge case — it was the product.
 *
 * ONLY THE UNDECIDED BAND REACHES HERE. The caller must have run both bounds first. That is
 * not an optimisation to be tidied away later: it is the whole cost model, and it matters
 * more than usual because ADR-0014 forbids caching a duration beyond the conversation that
 * produced it, so there is no long-lived cache to amortise a wasted call against.
 *
 * TRAFFIC-AWARE ONLY INSIDE ~24 HOURS. Beyond that Google increasingly returns historical
 * averages and bills the Pro SKU for the privilege — twice the price on half the free
 * allowance. Inside the window the traffic answer is worth paying for, because that is where
 * "45 minutes" and "70 minutes" are actually different journeys.
 *
 * THE CACHE IS SCOPED TO ONE CONVERSATION, and the key carries the routing preference and a
 * departure bucket. Both halves are load-bearing. The scope is a licence constraint: §19.3
 * of the Maps terms enumerates lat/lng and says nothing about durations, and §11.8 grants
 * duration explicitly for a different API, so the omission reads as deliberate. Holding one
 * for the life of a booking flow is a deliberate short reach, documented as such in ADR-0014
 * rather than claimed as a permission. The key is the correctness half: a rush-hour duration
 * replayed against a 2pm slot authorises a booking nobody can make.
 *
 * NEVER THROWS. Every failure is `unavailable`, because the caller is a booking path and an
 * exception escaping here would turn Google's downtime into a refused appointment. ADR-0015
 * says an outage degrades to the haversine bounds; it never degrades to a wrong answer.
 */
import axios from 'axios';
import { config } from '../../config/environment';
import { getRedisClient } from '../../config/redis';
import { logger } from '../../utils/logger';
import type { GeoPoint } from '../../contracts/travel';
import type { ActiveTravelEligibility } from './travel-eligibility';
import type { DriveLookup } from './travel-gate';
import { reserveTravelElements } from './travel-usage.service';

export type DriveResult =
  /** Google routed it. `minutes` is the duration to fit into the gap. */
  | { status: 'routed'; minutes: number }
  /**
   * Google found no drivable route for these coordinates with today's data.
   *
   * NOT a definite no, and it used to be treated as one. An island produces this; so does a
   * geocode landing in a canal, a road closed this week, and an address Google routes to
   * badly. Every other refusal in this system comes from a bound we control and can reason
   * about — this one is a third party's data quality, so the caller degrades it into a
   * Request the owner can see rather than turning a customer away on it.
   */
  | { status: 'no_route' }
  /**
   * A fact about Google, or about a tenant that has spent its month. Degrade, never refuse.
   *
   * `not_cached` is the odd one and is not a fault at all: a `cacheOnly` caller asked for a leg
   * this conversation had not already measured, and declined to buy it. `classifyCause` reads it
   * as `none` for exactly that reason.
   */
  | {
      status: 'unavailable';
      cause: 'no_api_key' | 'cap_exhausted' | 'api_error' | 'malformed_response' | 'departed' | 'not_cached';
    };

const ROUTES_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

/** Only what we read. A narrower mask is a smaller bill on some SKUs and a smaller surface here. */
const FIELD_MASK = 'originIndex,destinationIndex,duration,condition,status';

/**
 * A customer is waiting for slots behind this, and a slot list is several of these. Tighter
 * than the geocoding timeout because a matrix is a heavier computation on Google's side and
 * a slow one is more likely to be a bad minute than a hard problem — falling back to the
 * bounds is a better answer than making the customer wait twice.
 */
const TIMEOUT_MS = 5_000;

/**
 * Inside this, ask for traffic. Beyond it, do not.
 *
 * The number is Google's behaviour rather than our preference: past roughly a day the
 * traffic model degrades to historical averages, so the Pro SKU buys an average dressed as a
 * prediction. Note also that `departureTime` is REQUEST-level, so distinct departure times
 * cannot share one matrix — traffic-aware lookups cannot be batched even in principle.
 */
const TRAFFIC_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Fifteen minutes.
 *
 * The bucket exists so two candidate slots close together in the same conversation share a
 * lookup, and it is fifteen because that is short enough that no bucket spans the shoulder of
 * a rush hour. Traffic-UNAWARE answers are time-independent and deliberately bucket to a
 * constant, so a whole day of far-future candidates between one pair of addresses costs one
 * element rather than one per slot.
 */
const DEPARTURE_BUCKET_MS = 15 * 60 * 1000;

/**
 * Thirty minutes — the life of a conversation, not of a booking.
 *
 * Matched to the widget's own session auto-close so the cache cannot outlive the flow that
 * justified it. See the header: this TTL is the shape of a licence argument, not a
 * performance tuning knob, and lengthening it is a legal change rather than a config one.
 */
const CACHE_TTL_SECONDS = 30 * 60;

/** Bumped whenever the cached shape changes; old entries orphan and expire on their own TTL. */
const CACHE_VERSION = 'v1';

/** ~11 m. Two customers in one building must not each cost an element; a long street must not merge. */
const round5 = (n: number): string => n.toFixed(5);

/**
 * The cache key. Conversation, both ends, routing preference, departure bucket — all five.
 *
 * Dropping the session makes it a cross-conversation cache we do not hold a licence for.
 * Dropping the preference lets a traffic-free answer satisfy a traffic-aware question.
 * Dropping the bucket lets a rush-hour duration authorise a 2pm slot. None of the three is
 * an optimisation detail.
 */
export function driveCacheKey(input: {
  sessionId: string;
  from: GeoPoint;
  to: GeoPoint;
  trafficAware: boolean;
  bucket: number;
}): string {
  const pref = input.trafficAware ? 'ta' : 'tu';
  const from = `${round5(input.from.lat)},${round5(input.from.lng)}`;
  const to = `${round5(input.to.lat)},${round5(input.to.lng)}`;
  return `drive:${CACHE_VERSION}:${input.sessionId}:${pref}:${input.bucket}:${from}:${to}`;
}

/** Traffic-aware answers bucket by quarter hour; traffic-unaware ones are time-independent. */
export function departureBucket(departAt: Date, trafficAware: boolean): number {
  if (!trafficAware) return 0;
  return Math.floor(departAt.getTime() / DEPARTURE_BUCKET_MS);
}

interface MatrixElement {
  originIndex?: number;
  destinationIndex?: number;
  duration?: string;
  condition?: string;
  status?: { code?: number; message?: string };
}

async function readCache(key: string): Promise<DriveResult | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const hit = await redis.get(key);
    if (!hit) return null;
    const parsed = JSON.parse(hit) as DriveResult;
    // Matched against the union rather than merely being present, so anything else living at
    // this key cannot be returned as a verdict.
    if (parsed?.status === 'routed') return Number.isFinite(parsed.minutes) && parsed.minutes >= 0 ? parsed : null;
    // Neither `no_route` nor `unavailable` is cached — see the write path.
    return null;
  } catch (error) {
    logger.warn('[Travel] drive cache read failed', { error });
    return null;
  }
}

async function writeCache(key: string, result: DriveResult): Promise<void> {
  // An outage is a fact about this MOMENT, not about the pair. Caching it would extend one
  // bad second across the rest of a conversation, and the retry that would have succeeded
  // never happens. `no_route` is cached for the same reason it is not a refusal: it is a
  // claim about Google's current data, and one bad answer must not poison every remaining
  // slot in the conversation. The per-call budget bounds what re-asking can cost.
  if (result.status === 'unavailable' || result.status === 'no_route') return;
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn('[Travel] drive cache write failed', { error });
  }
}

/**
 * Drive time from `from` to `to`, departing at `departAt`.
 *
 * TAKES THE PROOF THAT THE GATES PASSED, not a tenant id — the same rule the geocoder
 * follows, and for the same reason: nothing may reach Google without an entitled Tenant and
 * an enabled Agent behind it, and a parameter is the only version of that a future caller
 * cannot forget to read.
 *
 * `sessionId` may be null, and then NOTHING IS CACHED. That is the honest reading of the
 * licence rather than an oversight: without a conversation to scope it to there is no
 * argument for holding the duration at all. The portal's own paths land here.
 */
export async function driveMinutes(
  eligibility: ActiveTravelEligibility,
  input: {
    from: GeoPoint;
    to: GeoPoint;
    departAt: Date;
    sessionId: string | null;
    /**
     * Answer from this conversation's cache or not at all. NEVER spends an element.
     *
     * For a caller that must be unable to affect what anybody else can afford. Grouping (#81) is
     * the case: it is a preference that improves an answer already correct without it, and it
     * shares one monthly counter with the feasibility gate. Any spend at all - however small a
     * fraction it is capped to - can bring a tenant to exhaustion they would not otherwise have
     * reached, and an exhausted gate turns confirmable slots into Requests. ADR-0017 forbids
     * grouping from causing that, so the guarantee has to be structural rather than a ceiling.
     */
    cacheOnly?: boolean;
    /**
     * Called on a `cacheOnly` MISS: the leg this caller declined to buy.
     *
     * The size of a caller's coverage gap, not a cost. #81 counts adjacent misses with it to see
     * how often the feasibility gate had not already routed the pair the scorer wanted.
     */
    onWouldSpend?: () => void;
    /**
     * Refuse to SPEND once this instant has passed. Epoch milliseconds.
     *
     * Checked immediately before the reservation, which is the last moment at which not spending
     * is still free. An optional caller races a whole pass against a deadline, but a race
     * abandons the wait rather than the work: a leg that starts at 1,999 ms of a 2,000 ms budget
     * goes on to reserve an element and call Google long after the customer was answered. The
     * read is already free by then; the purchase is not.
     *
     * WHAT IT GUARANTEES, exactly: no reservation is BEGUN once the deadline has passed. A
     * reservation already awaiting, or a request already in flight, still completes - a
     * check-then-act cannot promise otherwise, and nothing here can cancel either.
     */
    notAfter?: number;
    /**
     * Called exactly when an element is spent. Never for a cache hit, never under `cacheOnly`.
     *
     * Fires at the RESERVATION, before the request, and that is the honest moment rather than an
     * early one: Google bills the request and not the answer, so a timeout costs what a hit costs.
     * Waiting for a successful response would undercount every failure.
     */
    onBilled?: () => void;
  }
): Promise<DriveResult> {
  const apiKey = config.travel.googleMapsApiKey;
  if (!apiKey) return { status: 'unavailable', cause: 'no_api_key' };

  const departMs = input.departAt.getTime();
  if (!Number.isFinite(departMs)) return { status: 'unavailable', cause: 'malformed_response' };

  // Google rejects a departure in the past. A candidate slot that has just gone stale is a
  // normal race rather than an error, and the caller degrades to the bounds for it.
  const now = Date.now();
  if (departMs < now) return { status: 'unavailable', cause: 'departed' };

  const trafficAware = departMs - now <= TRAFFIC_HORIZON_MS;
  const bucket = departureBucket(input.departAt, trafficAware);
  const cacheKey = input.sessionId
    ? driveCacheKey({ sessionId: input.sessionId, from: input.from, to: input.to, trafficAware, bucket })
    : null;

  if (cacheKey) {
    const hit = await readCache(cacheKey);
    if (hit) return hit;
  }

  // BELOW THIS LINE COSTS MONEY, which is the whole reason the check sits exactly here: after the
  // cache and before the reservation.
  if (input.cacheOnly) {
    input.onWouldSpend?.();
    return { status: 'unavailable', cause: 'not_cached' };
  }
  // The last point at which not spending is still free. `>=` rather than `>`, so the deadline
  // instant itself is already too late - an off-by-one here buys an element for nobody.
  if (input.notAfter !== undefined && Date.now() >= input.notAfter) {
    return { status: 'unavailable', cause: 'not_cached' };
  }

  // Claimed BEFORE the request. Google bills the request rather than the answer, so a
  // timeout costs exactly what a hit costs. One origin by one destination is one element.
  if (!(await reserveTravelElements(eligibility.tenantId, 1))) {
    return { status: 'unavailable', cause: 'cap_exhausted' };
  }
  input.onBilled?.();

  const body: Record<string, unknown> = {
    origins: [{ waypoint: { location: { latLng: { latitude: input.from.lat, longitude: input.from.lng } } } }],
    destinations: [{ waypoint: { location: { latLng: { latitude: input.to.lat, longitude: input.to.lng } } } }],
    travelMode: 'DRIVE',
  };
  if (trafficAware) {
    body.routingPreference = 'TRAFFIC_AWARE';
    body.departureTime = new Date(departMs).toISOString();
  }

  let elements: MatrixElement[];
  try {
    const res = await axios.post<MatrixElement[]>(ROUTES_URL, body, {
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
      timeout: TIMEOUT_MS,
      validateStatus: (s) => s === 200,
    });
    elements = Array.isArray(res.data) ? res.data : [];
  } catch (error) {
    logger.warn('[Travel] routes unreachable', {
      tenantId: eligibility.tenantId,
      trafficAware,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'unavailable', cause: 'api_error' };
  }

  const result = interpret(elements, eligibility.tenantId);
  if (cacheKey) await writeCache(cacheKey, result);
  return result;
}

/**
 * The one element we asked for, in our vocabulary.
 *
 * A per-element `status.code` is Google reporting a problem with THIS pair while the request
 * itself succeeded, and it is not the same as no route existing — so it degrades rather than
 * refusing. Only an explicit `ROUTE_NOT_FOUND` is allowed to say no.
 */
function interpret(elements: MatrixElement[], tenantId: string): DriveResult {
  const el = elements[0];
  if (!el) {
    logger.warn('[Travel] routes returned no elements', { tenantId });
    return { status: 'unavailable', cause: 'malformed_response' };
  }

  if (el.status?.code) {
    logger.warn('[Travel] routes element carried an error', { tenantId, code: el.status.code });
    return { status: 'unavailable', cause: 'api_error' };
  }

  if (el.condition === 'ROUTE_NOT_FOUND') return { status: 'no_route' };

  // Seconds with a trailing `s`, per protobuf Duration. Anything else is a wire surprise and
  // must not be coerced — a NaN here would sail through the gap arithmetic as "no constraint".
  const raw = typeof el.duration === 'string' ? el.duration.trim() : '';
  const seconds = /^\d+(\.\d+)?s$/.test(raw) ? Number(raw.slice(0, -1)) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) {
    logger.warn('[Travel] routes returned an unreadable duration', { tenantId, duration: el.duration });
    return { status: 'unavailable', cause: 'malformed_response' };
  }

  // Rounded UP to the minute. The gap arithmetic works in whole minutes, and rounding a
  // drive down is the direction that authorises a booking the owner cannot make.
  return { status: 'routed', minutes: Math.ceil(seconds / 60) };
}

/**
 * The gate's `DriveLookup`, bound to one tenant and one conversation.
 *
 * The adapter exists so `travel-gate.ts` never learns what HTTP is: it is handed a function,
 * and every branch it takes is reachable in a unit test by handing it a different one. It
 * also collapses the client's four failure causes into the one distinction the gate acts on —
 * "no drivable route" refuses, everything else degrades — because a gate that branched on
 * `cap_exhausted` versus `api_error` would be re-deciding a question ADR-0015 already settled.
 */
export function driveLookupFor(
  eligibility: ActiveTravelEligibility,
  sessionId: string | null,
  /** Only an OPTIONAL caller passes these. Feasibility buys what it needs and counts nothing. */
  opts?: { cacheOnly?: boolean; onWouldSpend?: () => void; onBilled?: () => void; notAfter?: number }
): DriveLookup {
  return async (leg) => {
    const result = await driveMinutes(eligibility, {
      from: leg.from,
      to: leg.to,
      departAt: leg.departAt,
      sessionId,
      cacheOnly: opts?.cacheOnly,
      onWouldSpend: opts?.onWouldSpend,
      onBilled: opts?.onBilled,
      notAfter: opts?.notAfter,
    });
    if (result.status === 'routed') return { minutes: result.minutes };
    // NOT a refusal. `ROUTE_NOT_FOUND` says Google found no route for THESE coordinates with
    // TODAY's data — which a geocode into a canal, a closed road, or a pedestrianised address
    // all produce just as readily as an island does. Every other refusal in this system comes
    // from a bound we control and can reason about; this one is a third party's data quality,
    // and turning a customer away on it silently is the outcome this product least wants. It
    // degrades to a Request, where the owner sees the job and decides.
    if (result.status === 'no_route') return { minutes: null, cause: 'no_route' };
    // The cause rides along: the gate does not branch on it, but #68 has to tell a spent cap
    // (one tenant's problem) from a revoked key (everybody's), and this is where it exists.
    return { minutes: null, cause: result.cause };
  };
}
