/**
 * Where is this address? The one place that asks Google.
 *
 * `Booking.customerAddress` is `varchar(512)` of whatever a customer typed into a chat
 * window, and every travel question is arithmetic over a location we do not have. This
 * turns the string into a place: a durable `place_id`, coordinates, and a precision that
 * says how much of that to believe.
 *
 * GEOCODING v3, NOT v4, and that is a correctness choice rather than inertia. v4 went GA
 * on 2026-03-30 and removed both hard `components` country filtering and `partial_match`
 * reporting, which are exactly the two controls that make a `ROOFTOP` result trustworthy
 * (ADR-0014). v3 is not deprecated.
 *
 * PRECISION IS NOT CORRECTNESS. `ROOFTOP` means Google placed the string confidently, not
 * that it placed it correctly. The country restriction stops "Springfield" landing in
 * Illinois, and `partial_match` is how Google says "I matched some of what you asked for",
 * which is a different claim from the one the precision label makes, and it is the one that
 * catches a misspelt street silently resolving to a real one nearby.
 *
 * THREE OUTCOMES, AND THE THIRD IS NOT A KIND OF FAILURE. `placed` and `not_placeable` are
 * facts about the ADDRESS; `unavailable` is a fact about GOOGLE, or about a tenant that has
 * spent its month. ADR-0015 turns on telling those apart: a vague address has a recovery the
 * customer can act on, and an outage does not, so collapsing them would ask a customer for a
 * postcode that could not possibly help.
 */
import { createHash } from 'node:crypto';
import axios from 'axios';
import { config } from '../../config/environment';
import { getRedisClient } from '../../config/redis';
import { logger } from '../../utils/logger';
import { isTrustedForTravel, type GeocodePrecision } from '../../contracts/travel';
import type { ActiveTravelEligibility } from './travel-eligibility';
import { reserveTravelElements } from './travel-usage.service';

/** A placed address: Google's durable identity, its position, and how much to trust it. */
export interface PlacedAddress {
  /** Storable indefinitely (ADR-0014). The stable thing coordinates are re-derived from. */
  placeId: string;
  lat: number;
  lng: number;
  precision: GeocodePrecision;
  /**
   * Google's canonical spelling of the place we actually placed, which is not always what
   * the customer typed. Bound to the booking so create cannot silently confirm against a
   * different string than the one that was checked.
   */
  formattedAddress: string;
  /**
   * The same address broken into fields, when Google gave them. Optional and PURELY additive:
   * nothing that routes reads it, `isUsablePlace` does not require it, and a cache entry written
   * before this existed stays valid. It is here so a form with four boxes can be filled from the
   * one lookup that already happened.
   */
  components?: AddressComponents;
}

export type GeocodeResult =
  | { status: 'placed'; place: PlacedAddress }
  /** A fact about the address. There is a recovery and the customer can act on it. */
  | { status: 'not_placeable'; cause: 'zero_results' | 'partial_match' }
  /** A fact about Google, or about a tenant that has spent its month. No recovery. */
  | { status: 'unavailable'; cause: 'no_api_key' | 'cap_exhausted' | 'api_error' | 'malformed_response' };

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

/**
 * Belgium, hardcoded, because the platform is.
 *
 * The municipality table, the service-area matcher and the VAT register this product signs
 * businesses up through are all Belgium-only. This is the hard `components` filter ADR-0014
 * chose v3 to keep: without it a bare street name resolves happily on another continent.
 */
const GEOCODE_COUNTRY = 'BE';

/**
 * A customer is waiting for slots behind this. Geocoding is a CDN-backed lookup rather than
 * a government register, so the tail is short and a slow answer is worth less than a fast
 * "we could not place it" that keeps the conversation moving.
 */
const TIMEOUT_MS = 6_000;

/**
 * A week.
 *
 * The ceiling is not a performance judgement: ADR-0014 permits caching latitude and
 * longitude for 30 consecutive calendar days and no longer, so any cache holding them must
 * expire well inside that. A week is comfortably under it, and short enough that a
 * corrected address or a Google data fix reaches us without anyone intervening.
 */
const PLACED_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * An hour, for "we could not place that".
 *
 * Cached at all so a retry loop, or someone feeding one bad string at a widget, cannot spend
 * an element per attempt. Cached BRIEFLY because a negative here is usually about how the
 * customer typed it rather than about the world, and holding it for a week would outlive the
 * conversation that could have corrected it.
 */
const NOT_PLACEABLE_TTL_SECONDS = 60 * 60;

/** The width of `chatbot_bookings.customer_address_verified`. Longer is an anomaly, not an address. */
const MAX_VERIFIED_ADDRESS_CHARS = 512;

/**
 * Bumped whenever the cached SHAPE changes.
 *
 * A stored `GeocodeResult` is read back with a cast, so a future field that old entries lack
 * would be silently undefined rather than a parse error. Versioning the key orphans the old
 * entries instead, and they expire on their own TTL.
 */
const CACHE_VERSION = 'v1';

/**
 * The cache key, and the reason two customers in one building cost one element.
 *
 * HASHED, because a customer's home address is not operational data. Redis keys surface in
 * `SCAN` output, slow logs, memory-analysis tools and monitoring dashboards, none of which
 * anyone thinks of as a place personal data lives. The digest keys just as well.
 *
 * Case and whitespace are folded away first, since they are noise a customer generates for
 * free. Anything else is left alone: deciding that "straat" and "str." are the same address
 * is Google's job, and doing it here would merge two genuinely different strings.
 */
export function geocodeCacheKey(address: string): string {
  const normalised = address.trim().toLowerCase().replace(/\s+/g, ' ');
  const digest = createHash('sha256').update(normalised).digest('hex').slice(0, 32);
  return `geocode:${CACHE_VERSION}:${GEOCODE_COUNTRY}:${digest}`;
}

/**
 * Google's `location_type` in our vocabulary, or null for a value we do not know.
 *
 * Null is deliberate rather than a default to `approximate`: an unrecognised precision is a
 * wire-format surprise, and quietly filing it under the one value that never clears a drive
 * would hide the surprise while looking like a safe choice. The caller treats null as
 * unusable, which it is.
 */
export function precisionFromLocationType(value: unknown): GeocodePrecision | null {
  switch (value) {
    case 'ROOFTOP':
      return 'rooftop';
    case 'RANGE_INTERPOLATED':
      return 'range_interpolated';
    case 'GEOMETRIC_CENTER':
      return 'geometric_center';
    case 'APPROXIMATE':
      return 'approximate';
    default:
      return null;
  }
}

interface GeocodeResponse {
  status?: string;
  error_message?: string;
  results?: Array<{
    place_id?: string;
    formatted_address?: string;
    partial_match?: boolean;
    geometry?: { location?: { lat?: number; lng?: number }; location_type?: string };
    address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }>;
  }>;
}

/**
 * The pieces of an address, for a form that has a field per piece.
 *
 * Geocoding v3 has always returned these and we have always thrown them away, because travel
 * only ever needed a point. The portal's venue form needs four separate fields, and inferring
 * them by splitting `formattedAddress` on commas is guesswork that breaks on the first address
 * whose city contains one.
 *
 * Every field is optional. Google omits components it has no answer for, and a venue that is
 * missing a house number is still a usable venue.
 */
export interface AddressComponents {
  street?: string;
  postalCode?: string;
  city?: string;
  /** ISO 3166-1 alpha-2, which is what `VenueAddress.country` stores. */
  country?: string;
}

/** `types` is an array, so a component is claimed by membership rather than by position. */
function componentsFrom(
  raw: Array<{ long_name?: string; short_name?: string; types?: string[] }> | undefined
): AddressComponents | undefined {
  if (!raw?.length) return undefined;
  const find = (type: string) => raw.find((c) => c.types?.includes(type));
  const number = find('street_number')?.long_name?.trim();
  const route = find('route')?.long_name?.trim();
  const out: AddressComponents = {
    // "Grote Markt 1", the order Belgian and Dutch addresses are written in. Either half may be
    // absent, so the pieces are joined rather than templated.
    street: [route, number].filter(Boolean).join(' ') || undefined,
    postalCode: find('postal_code')?.long_name?.trim() || undefined,
    // `locality` is the town. Brussels-region addresses often carry only the commune, so
    // `postal_town` and the level-2 area stand in rather than leaving the field blank.
    city:
      (find('locality') ?? find('postal_town') ?? find('administrative_area_level_2'))?.long_name?.trim() ||
      undefined,
    // SHORT name deliberately: the column holds ISO 3166-1 alpha-2, and `long_name` is "Belgium".
    country: find('country')?.short_name?.trim() || undefined,
  };
  return Object.values(out).some(Boolean) ? out : undefined;
}

/**
 * Is this a placement we are willing to act on?
 *
 * THE ONE BOUNDARY, and every source of a placement crosses it: Google's live answer, an
 * entry read back out of Redis, and a row read back out of Postgres. Each of those arrives
 * through a cast that the compiler cannot check, and each can be wrong in a different way —
 * a wire-format change, a half-written cache entry, a hand-edited row. Validating in one
 * place is what stops two of the three quietly getting a weaker check than the third.
 *
 * Coordinates are RANGE-checked rather than merely finite: a glitch putting a latitude at
 * 900 is not a position, and haversine will happily compute a distance from it. `precision`
 * is checked for membership rather than truthiness, so an unrecognised string cannot arrive
 * claiming to be a precision nothing downstream knows how to weigh.
 */
export function isUsablePlace(place: PlacedAddress | undefined | null): place is PlacedAddress {
  if (!place) return false;
  // No length ceiling: Google documents that place ids have no maximum length, which is why
  // the column holding this is TEXT.
  if (typeof place.placeId !== 'string' || !place.placeId.trim()) return false;
  if (!isTrustedForTravel(place.precision) && place.precision !== 'approximate') return false;
  // Required because it is the VERIFIED string bound to the booking, and a placement without
  // one leaves the row unable to say which address was actually checked. Bounded because the
  // column is, and a value that would not fit must be refused rather than trimmed to size.
  if (typeof place.formattedAddress !== 'string' || !place.formattedAddress.trim()) return false;
  if (place.formattedAddress.length > MAX_VERIFIED_ADDRESS_CHARS) return false;
  if (!Number.isFinite(place.lat) || place.lat < -90 || place.lat > 90) return false;
  if (!Number.isFinite(place.lng) || place.lng < -180 || place.lng > 180) return false;
  return true;
}

/** Read the cache. A cache that is down means every lookup is paid for, never that lookups stop. */
async function readCache(key: string): Promise<GeocodeResult | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const hit = await redis.get(key);
    if (!hit) return null;
    const parsed = JSON.parse(hit) as GeocodeResult;
    // A stored answer that would not survive the live checks is treated as a miss, not as an
    // answer. Paying for one lookup again is the cheap outcome here. The status is matched
    // against the union rather than merely being present, so arbitrary JSON left at this key
    // by anything other than `writeCache` cannot be returned as a verdict.
    if (parsed?.status === 'placed') return isUsablePlace(parsed.place) ? parsed : null;
    if (parsed?.status === 'not_placeable' || parsed?.status === 'unavailable') return parsed;
    return null;
  } catch (error) {
    logger.warn('[Travel] geocode cache read failed', { error });
    return null;
  }
}

async function writeCache(key: string, result: GeocodeResult, ttlSeconds: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(result), 'EX', ttlSeconds);
  } catch (error) {
    logger.warn('[Travel] geocode cache write failed', { error });
  }
}

/**
 * Place `address`, spending at most one billable element.
 *
 * NEVER THROWS. Every way this can go wrong is one of the three outcomes, because the
 * callers are booking paths and an exception escaping here would turn someone else's
 * downtime into a refused appointment.
 *
 * TAKES THE PROOF THAT THE GATES PASSED, not a tenant id. Nothing on this platform may
 * reach Google without an entitled Tenant and an enabled Agent behind it, and a parameter is
 * the only version of that rule a future caller cannot forget to read.
 *
 * The order of the first three steps is the whole cost model. The cache answers the common
 * case for nothing, the spend guard stops a runaway tenant before the request rather than
 * after it, and only then does anything reach Google. The cap check sits here rather than in
 * `resolveTravelEligibility` on purpose: exhausting it is ADR-0015's degraded branch, not
 * inertness, so it must be visible as its own cause.
 */
export async function geocodeAddress(
  eligibility: ActiveTravelEligibility,
  address: string
): Promise<GeocodeResult> {
  const { tenantId } = eligibility;
  const apiKey = config.travel.googleMapsApiKey;
  if (!apiKey) return { status: 'unavailable', cause: 'no_api_key' };

  const trimmed = address.trim();
  if (!trimmed) return { status: 'not_placeable', cause: 'zero_results' };

  return lookup(tenantId, geocodeCacheKey(trimmed), {
    address: trimmed,
    components: `country:${GEOCODE_COUNTRY}`,
    key: apiKey,
  });
}

/**
 * Coordinates for a place we have already identified, from its `place_id`.
 *
 * THE REFRESH PATH, and it must not be a second forward geocode. ADR-0014 permits latitude
 * and longitude for 30 consecutive days while `place_id` may be kept for the life of the
 * booking, so re-resolving before a far-future appointment is the normal path rather than an
 * edge case. Going back through the customer's typed address to do it would let the booking
 * quietly change identity: the same string can resolve somewhere else months later, and an
 * address that was ambiguous the first time is ambiguous again. The place id is exactly the
 * durable handle that makes the refresh identity-preserving.
 *
 * No `components` filter: a place id is an exact identity, so there is nothing to restrict
 * and nothing to partially match.
 *
 * TAKES A TENANT, NOT AN ELIGIBILITY, and the difference is the point. Resolving an id the
 * customer or the owner PICKED is not a travel decision - it is how an address gets verified at
 * all - so it has to work on a bot with travel switched off, on an unentitled tenant, and on one
 * whose itinerary key is shared. Demanding an `ActiveTravelEligibility` made verified addresses
 * available precisely where travel already worked and nowhere else, which is backwards.
 *
 * The tenant is still required, because the spend cap is not optional: `lookup` reserves an
 * element against it before calling Google. Callers holding an eligibility pass its `tenantId`.
 */
export async function resolvePlaceId(
  tenantId: string,
  placeId: string
): Promise<GeocodeResult> {
  const apiKey = config.travel.googleMapsApiKey;
  if (!apiKey) return { status: 'unavailable', cause: 'no_api_key' };
  if (!placeId.trim()) return { status: 'unavailable', cause: 'malformed_response' };

  return lookup(tenantId, `geocode:${CACHE_VERSION}:place:${placeId}`, {
    place_id: placeId,
    key: apiKey,
  });
}

/** Cache, reserve, call, judge, store. Shared by both lookups so neither can skip a step. */
async function lookup(
  tenantId: string,
  cacheKey: string,
  params: Record<string, string>
): Promise<GeocodeResult> {
  const hit = await readCache(cacheKey);
  if (hit) return hit;

  // Claimed BEFORE the request, and claiming is what decides whether we may make it. Google
  // bills the request rather than the answer, so a timeout costs exactly what a hit costs,
  // and counting afterwards would leave every concurrent caller reading the same
  // under-limit total and all of them proceeding.
  if (!(await reserveTravelElements(tenantId, 1))) {
    return { status: 'unavailable', cause: 'cap_exhausted' };
  }

  let body: GeocodeResponse;
  try {
    const res = await axios.get<GeocodeResponse>(GEOCODE_URL, {
      params,
      timeout: TIMEOUT_MS,
      validateStatus: (s) => s === 200,
    });
    body = res.data ?? {};
  } catch (error) {
    logger.warn('[Travel] geocoding unreachable', {
      tenantId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { status: 'unavailable', cause: 'api_error' };
  }

  const result = interpret(body, tenantId);
  if (result.status !== 'unavailable') {
    await writeCache(cacheKey, result, result.status === 'placed' ? PLACED_TTL_SECONDS : NOT_PLACEABLE_TTL_SECONDS);
  }
  return result;
}

/**
 * The wire format, judged.
 *
 * THE LINE THIS FUNCTION DRAWS is between a fact about the ADDRESS and a fact about GOOGLE,
 * because the two get different treatment and only one of them has a recovery. `ZERO_RESULTS`
 * and `partial_match` are the address: a customer can add a postcode and settle them.
 * Anything else that stops us producing a placed address is Google, and asking that customer
 * for a postcode would be friction that could not possibly help.
 *
 * That is why an `OK` carrying no results, or a result missing a field we require, reads as
 * `unavailable` rather than `not_placeable`. Google documents `ZERO_RESULTS` for "no match",
 * so an `OK` that fails to produce one is the API misbehaving, and blaming the customer's
 * typing for it is both wrong and unactionable.
 *
 * `OVER_DAILY_LIMIT` deserves its own mention: it is what a lapsed free trial looks like from
 * here, and rollout gate 5 exists because that failure is permanent, platform-wide and
 * otherwise silent.
 */
function interpret(body: GeocodeResponse, tenantId: string): GeocodeResult {
  const status = body.status;
  if (status === 'ZERO_RESULTS') return { status: 'not_placeable', cause: 'zero_results' };
  if (status !== 'OK') {
    logger.warn('[Travel] geocoding refused the request', {
      tenantId,
      status,
      // Google puts the actionable detail here: a disabled API, a lapsed billing account, a
      // key restricted to the wrong referrer. Losing it makes every one of those look alike.
      message: body.error_message,
    });
    return { status: 'unavailable', cause: 'api_error' };
  }

  const top = body.results?.[0];
  if (!top) {
    logger.warn('[Travel] geocoding answered OK with no results', { tenantId });
    return { status: 'unavailable', cause: 'malformed_response' };
  }

  // A PARTIAL MATCH IS NOT A PLACEMENT, whatever precision rides alongside it. Google is
  // saying it matched part of what was asked and filled in the rest, so a `ROOFTOP` here is
  // a confident placement of an address nobody typed. There is no column that could carry
  // "confident, but of the wrong thing" onto the row, so the honest answer is that we did
  // not place it - and the recovery that follows asks for the postcode that would settle it.
  if (top.partial_match === true) return { status: 'not_placeable', cause: 'partial_match' };

  const lat = top.geometry?.location?.lat;
  const lng = top.geometry?.location?.lng;
  const formattedAddress = top.formatted_address?.trim() ?? '';
  const place: PlacedAddress = {
    placeId: top.place_id ?? '',
    lat: lat as number,
    lng: lng as number,
    precision: precisionFromLocationType(top.geometry?.location_type) as GeocodePrecision,
    formattedAddress,
    components: componentsFrom(top.address_components),
  };

  // NOT TRUNCATED TO FIT. The verified address is bounded inside `isUsablePlace` rather than
  // sliced here: a Belgian formatted address runs to about sixty characters, so one that
  // would not fit the column is an anomaly rather than a long address, and trimming it would
  // store a string Google never returned while calling the placement verified. That is the
  // exact silent wrongness this ticket exists to prevent.
  if (!isUsablePlace(place)) {
    logger.warn('[Travel] geocoding returned a result we cannot use', {
      tenantId,
      hasPlaceId: !!top.place_id,
      verifiedAddressChars: formattedAddress.length,
      locationType: top.geometry?.location_type,
    });
    return { status: 'unavailable', cause: 'malformed_response' };
  }

  return { status: 'placed', place };
}
