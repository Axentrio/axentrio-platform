/**
 * The Geocoding client. What is worth pinning here is not "does it parse JSON" but the
 * handful of judgements that decide whether a wrong answer can reach a booking: the country
 * restriction, the refusal to accept a partial match at any precision, and the split between
 * an address we cannot place and a Google we cannot reach.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const axiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => axiosGet(...a) } }));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { travelConfig } = vi.hoisted(() => ({
  travelConfig: { googleMapsApiKey: 'test-key' as string | undefined, monthlyElementCapPerTenant: 5000 },
}));
vi.mock('../../config/environment', () => ({ config: { travel: travelConfig } }));

const redis = vi.hoisted(() => ({
  client: null as null | { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> },
}));
vi.mock('../../config/redis', () => ({ getRedisClient: () => redis.client }));

const reserve = vi.fn(async () => true);
vi.mock('../../booking/travel/travel-usage.service', () => ({
  reserveTravelElements: (...a: unknown[]) => reserve(...(a as [])),
}));

import type { ActiveTravelEligibility } from '../../booking/travel/travel-eligibility';
import {
  geocodeAddress,
  resolvePlaceId,
  geocodeCacheKey,
  precisionFromLocationType,
} from '../../booking/travel/geocoding.service';

/**
 * Proof that all four gates passed. It is a parameter rather than a tenant id precisely so
 * that no future caller can reach Google without holding one, which is what makes "only ever
 * for an entitled Tenant on an enabled Agent" a compiler rule instead of a comment.
 */
const ELIGIBLE: ActiveTravelEligibility = {
  active: true,
  tenantId: 'ten-1',
  itineraryKey: 'cal:abc' as ActiveTravelEligibility['itineraryKey'],
  slackMin: 5,
  startFromBase: false, maxDetourMin: null, baseDepartOffsetMin: 0, groupingPeriod: 'none' as const, routePriority: 'auto' as const,
};

const ok = (result: Record<string, unknown>) => ({ data: { status: 'OK', results: [result] } });

/** Google's wire shape, snake_case. */
const ROOFTOP = {
  place_id: 'ChIJ_place',
  formatted_address: 'Kerkstraat 12, 9000 Gent, Belgium',
  geometry: { location: { lat: 51.05, lng: 3.72 }, location_type: 'ROOFTOP' },
};

/** OUR shape, which is what a cache entry actually holds. Not interchangeable with ROOFTOP. */
const CACHED = {
  placeId: 'ChIJ_place',
  lat: 51.05,
  lng: 3.72,
  precision: 'rooftop',
  formattedAddress: 'Kerkstraat 12, 9000 Gent, Belgium',
};

beforeEach(() => {
  vi.clearAllMocks();
  travelConfig.googleMapsApiKey = 'test-key';
  redis.client = null;
  reserve.mockResolvedValue(true);
});

describe('precisionFromLocationType', () => {
  it('maps every value Google documents', () => {
    expect(precisionFromLocationType('ROOFTOP')).toBe('rooftop');
    expect(precisionFromLocationType('RANGE_INTERPOLATED')).toBe('range_interpolated');
    expect(precisionFromLocationType('GEOMETRIC_CENTER')).toBe('geometric_center');
    expect(precisionFromLocationType('APPROXIMATE')).toBe('approximate');
  });

  it('answers null for anything else rather than defaulting to the safe-looking value', () => {
    // `approximate` would LOOK like the cautious default and would hide a wire-format
    // change behind a value that reads as a legitimate town-centre placement.
    expect(precisionFromLocationType('SOMETHING_NEW')).toBeNull();
    expect(precisionFromLocationType(undefined)).toBeNull();
  });
});

describe('geocodeCacheKey', () => {
  it('folds away the noise a customer generates for free', () => {
    expect(geocodeCacheKey('  Kerkstraat 12,   9000 GENT ')).toBe(
      geocodeCacheKey('kerkstraat 12, 9000 gent')
    );
  });

  it('keeps genuinely different strings apart', () => {
    expect(geocodeCacheKey('Kerkstraat 12, Gent')).not.toBe(geocodeCacheKey('Kerkstraat 13, Gent'));
  });

  it('never puts a customer address into the key itself', () => {
    // Redis keys surface in SCAN output, slow logs and memory-analysis tools, none of which
    // anyone thinks of as a place personal data lives.
    const key = geocodeCacheKey('Kerkstraat 12, 9000 Gent');
    expect(key).not.toMatch(/kerkstraat/i);
    expect(key).not.toContain('9000');
    // Versioned, so a future change to the stored shape orphans old entries instead of
    // reading them back through a cast that cannot notice a missing field.
    expect(key).toMatch(/^geocode:v1:BE:[0-9a-f]{32}$/);
  });
});

describe('geocodeAddress', () => {
  it('places a rooftop result and carries the durable identity', async () => {
    axiosGet.mockResolvedValue(ok(ROOFTOP));
    const result = await geocodeAddress(ELIGIBLE, 'Kerkstraat 12, 9000 Gent');
    expect(result).toEqual({
      status: 'placed',
      place: {
        placeId: 'ChIJ_place',
        lat: 51.05,
        lng: 3.72,
        precision: 'rooftop',
        formattedAddress: 'Kerkstraat 12, 9000 Gent, Belgium',
      },
    });
  });

  it('restricts the request to Belgium', async () => {
    axiosGet.mockResolvedValue(ok(ROOFTOP));
    await geocodeAddress(ELIGIBLE, 'Kerkstraat 12');
    const [, opts] = axiosGet.mock.calls[0] as [string, { params: Record<string, string> }];
    // Without this, a bare street name resolves happily on another continent. It is one of
    // the two controls ADR-0014 stayed on v3 for.
    expect(opts.params.components).toBe('country:BE');
    expect(opts.params.key).toBe('test-key');
  });

  it('REFUSES a partial match even at rooftop precision', async () => {
    axiosGet.mockResolvedValue(ok({ ...ROOFTOP, partial_match: true }));
    // A confident placement of an address nobody typed. No column can carry "confident, but
    // of the wrong thing", so the honest answer is that it did not place.
    expect(await geocodeAddress(ELIGIBLE, 'Kerkstaat 12, Gent')).toEqual({
      status: 'not_placeable',
      cause: 'partial_match',
    });
  });

  it('places an approximate result - the untrusted decision belongs downstream', async () => {
    axiosGet.mockResolvedValue(
      ok({ ...ROOFTOP, geometry: { ...ROOFTOP.geometry, location_type: 'APPROXIMATE' } })
    );
    const result = await geocodeAddress(ELIGIBLE, 'Gent');
    // Recorded in full: a town centre can still PROVE a drive impossible, and the row is the
    // only record of what the gate had to work with.
    expect(result).toMatchObject({ status: 'placed', place: { precision: 'approximate' } });
  });

  it('treats ZERO_RESULTS as a fact about the address', async () => {
    axiosGet.mockResolvedValue({ data: { status: 'ZERO_RESULTS', results: [] } });
    expect(await geocodeAddress(ELIGIBLE, 'qqqq')).toEqual({ status: 'not_placeable', cause: 'zero_results' });
  });

  it.each([
    ['a missing place id', { place_id: undefined }],
    ['a missing verified address', { formatted_address: undefined }],
    ['an unknown precision', { geometry: { location: { lat: 51, lng: 3 }, location_type: 'NEW_THING' } }],
  ])('blames GOOGLE, not the customer, for %s', async (_label, broken) => {
    axiosGet.mockResolvedValue(ok({ ...ROOFTOP, ...broken }));
    // A malformed OK is the API misbehaving. Filing it as "your address is vague" would send
    // the customer into a postcode recovery that cannot possibly fix it.
    expect(await geocodeAddress(ELIGIBLE, 'Kerkstraat 12')).toEqual({
      status: 'unavailable',
      cause: 'malformed_response',
    });
  });

  it('blames Google for an OK carrying no results at all', async () => {
    // ZERO_RESULTS is the documented way to say "no match", so an empty OK is not one.
    axiosGet.mockResolvedValue({ data: { status: 'OK', results: [] } });
    expect(await geocodeAddress(ELIGIBLE, 'Kerkstraat 12')).toEqual({
      status: 'unavailable',
      cause: 'malformed_response',
    });
  });

  it.each([
    ['a latitude off the globe', { location: { lat: 900, lng: 3.72 }, location_type: 'ROOFTOP' }],
    ['a longitude off the globe', { location: { lat: 51.05, lng: -400 }, location_type: 'ROOFTOP' }],
  ])('refuses %s rather than handing it to haversine', async (_label, geometry) => {
    axiosGet.mockResolvedValue(ok({ ...ROOFTOP, geometry }));
    expect(await geocodeAddress(ELIGIBLE, 'Kerkstraat 12')).toMatchObject({ status: 'unavailable' });
  });

  it('refuses a verified address too long for the column instead of truncating it', async () => {
    axiosGet.mockResolvedValue(ok({ ...ROOFTOP, formatted_address: 'x'.repeat(513) }));
    // Trimming to fit would store a string Google never returned while calling the placement
    // verified, which is the exact silent wrongness this ticket exists to prevent.
    expect(await geocodeAddress(ELIGIBLE, 'Kerkstraat 12')).toEqual({
      status: 'unavailable',
      cause: 'malformed_response',
    });
  });

  describe('resolvePlaceId', () => {
    it('takes a tenant rather than an eligibility, so a verified address does not need travel on', async () => {
      // The whole reason the signature narrowed. Picking an address is how one gets verified at
      // all; it is not a travel decision, and it has to work on a bot with travel switched off,
      // on an unentitled tenant, and on one whose itinerary key is shared. The spend cap still
      // applies, which is why a tenant is still required.
      axiosGet.mockResolvedValue(ok(ROOFTOP));
      expect(await resolvePlaceId('ten-no-travel', 'ChIJ_place')).toMatchObject({ status: 'placed' });
      expect(reserve).toHaveBeenCalledWith('ten-no-travel', 1);
    });

    it('refreshes by identity, with no country filter to partially match against', async () => {
      axiosGet.mockResolvedValue(ok(ROOFTOP));
      expect(await resolvePlaceId(ELIGIBLE.tenantId, 'ChIJ_place')).toMatchObject({ status: 'placed' });
      const [, opts] = axiosGet.mock.calls[0] as [string, { params: Record<string, string> }];
      expect(opts.params.place_id).toBe('ChIJ_place');
      expect(opts.params.address).toBeUndefined();
      expect(opts.params.components).toBeUndefined();
    });

    it('claims an element like any other lookup', async () => {
      axiosGet.mockResolvedValue(ok(ROOFTOP));
      await resolvePlaceId(ELIGIBLE.tenantId, 'ChIJ_place');
      expect(reserve).toHaveBeenCalledWith('ten-1', 1);
    });

    it('caches under the place id, not the address', async () => {
      redis.client = { get: vi.fn(async () => null), set: vi.fn(async () => 'OK') };
      axiosGet.mockResolvedValue(ok(ROOFTOP));
      await resolvePlaceId(ELIGIBLE.tenantId, 'ChIJ_place');
      expect(redis.client.set.mock.calls[0][0]).toBe('geocode:v1:place:ChIJ_place');
    });
  });

  it.each(['REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'OVER_DAILY_LIMIT', 'UNKNOWN_ERROR'])(
    'treats %s as a fact about GOOGLE, not about the address',
    async (status) => {
      axiosGet.mockResolvedValue({ data: { status, error_message: 'billing' } });
      // OVER_DAILY_LIMIT is what a lapsed free trial looks like from here. Filing it under
      // "vague address" would ask the customer for a postcode that cannot possibly help.
      expect(await geocodeAddress(ELIGIBLE, 'Kerkstraat 12')).toEqual({
        status: 'unavailable',
        cause: 'api_error',
      });
    }
  );

  it('is unavailable, never thrown, when the call fails outright', async () => {
    axiosGet.mockRejectedValue(new Error('ETIMEDOUT'));
    expect(await geocodeAddress(ELIGIBLE, 'Kerkstraat 12')).toEqual({
      status: 'unavailable',
      cause: 'api_error',
    });
  });

  it('is inert with no API key, and never reaches the meter', async () => {
    travelConfig.googleMapsApiKey = undefined;
    expect(await geocodeAddress(ELIGIBLE, 'Kerkstraat 12')).toEqual({
      status: 'unavailable',
      cause: 'no_api_key',
    });
    expect(axiosGet).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  describe('the meter', () => {
    it('claims the element BEFORE the request, not after it', async () => {
      axiosGet.mockResolvedValue(ok(ROOFTOP));
      await geocodeAddress(ELIGIBLE, 'Kerkstraat 12');
      // Google bills the request rather than the answer, so a timeout costs what a hit
      // costs. Counting afterwards would also leave a window in which every concurrent
      // caller reads the same under-limit total and all of them proceed.
      expect(reserve).toHaveBeenCalledWith('ten-1', 1);
      expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(axiosGet.mock.invocationCallOrder[0]);
    });

    it('keeps the element claimed when the call then fails', async () => {
      axiosGet.mockRejectedValue(new Error('ETIMEDOUT'));
      await geocodeAddress(ELIGIBLE, 'Kerkstraat 12');
      expect(reserve).toHaveBeenCalledWith('ten-1', 1);
    });

    it('stops BEFORE the request when the tenant has spent its month', async () => {
      reserve.mockResolvedValue(false);
      expect(await geocodeAddress(ELIGIBLE, 'Kerkstraat 12')).toEqual({
        status: 'unavailable',
        cause: 'cap_exhausted',
      });
      // A cap enforced after the call is not a cap.
      expect(axiosGet).not.toHaveBeenCalled();
    });
  });

  describe('the cache', () => {
    beforeEach(() => {
      redis.client = { get: vi.fn(async () => null), set: vi.fn(async () => 'OK') };
    });

    it('answers a hit without calling Google or the meter', async () => {
      redis.client!.get.mockResolvedValue(JSON.stringify({ status: 'placed', place: CACHED }));
      const result = await geocodeAddress(ELIGIBLE, 'Kerkstraat 12');
      expect(result).toMatchObject({ status: 'placed' });
      expect(axiosGet).not.toHaveBeenCalled();
      // A hit claims nothing: two customers in one building cost one element between them.
      expect(reserve).not.toHaveBeenCalled();
    });

    it('stores a placement for a week, well inside the 30-day licence on coordinates', async () => {
      axiosGet.mockResolvedValue(ok(ROOFTOP));
      await geocodeAddress(ELIGIBLE, 'Kerkstraat 12');
      expect(redis.client!.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'EX',
        7 * 24 * 60 * 60
      );
    });

    it('stores a not-placeable briefly - it is about how they typed it, not about the world', async () => {
      axiosGet.mockResolvedValue({ data: { status: 'ZERO_RESULTS', results: [] } });
      await geocodeAddress(ELIGIBLE, 'qqqq');
      expect(redis.client!.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'EX', 3600);
    });

    it('NEVER stores an outage', async () => {
      axiosGet.mockResolvedValue({ data: { status: 'REQUEST_DENIED' } });
      await geocodeAddress(ELIGIBLE, 'Kerkstraat 12');
      // Caching this would extend a five-minute Google blip into an hour of pretending.
      expect(redis.client!.set).not.toHaveBeenCalled();
    });

    it.each([
      ['a latitude off the globe', { lat: 900 }],
      ['a longitude off the globe', { lng: -400 }],
      ['a verified address too long for the column', { formattedAddress: 'x'.repeat(513) }],
      ['a precision nothing downstream knows how to weigh', { precision: 'VERY_GOOD' }],
      ['no durable identity', { placeId: '' }],
      ['a whitespace-only identity', { placeId: '   ' }],
    ])('treats a cached placement with %s as a miss', async (_label, broken) => {
      // The cache holds our own JSON and is read back through a cast, so without re-checking
      // it a corrupted entry would skip every validation the live response had to pass.
      redis.client!.get.mockResolvedValue(JSON.stringify({ status: 'placed', place: { ...CACHED, ...broken } }));
      axiosGet.mockResolvedValue(ok(ROOFTOP));
      expect(await geocodeAddress(ELIGIBLE, 'Kerkstraat 12')).toMatchObject({ status: 'placed' });
      // Paying for one lookup again is the cheap outcome; trusting the entry is not.
      expect(axiosGet).toHaveBeenCalled();
    });

    it('ignores a key holding something no writer of ours could have produced', async () => {
      redis.client!.get.mockResolvedValue(JSON.stringify({ status: 'definitely_fine' }));
      axiosGet.mockResolvedValue(ok(ROOFTOP));
      expect(await geocodeAddress(ELIGIBLE, 'Kerkstraat 12')).toMatchObject({ status: 'placed' });
      expect(axiosGet).toHaveBeenCalled();
    });

    it('still answers when Redis is down', async () => {
      redis.client!.get.mockRejectedValue(new Error('ECONNREFUSED'));
      redis.client!.set.mockRejectedValue(new Error('ECONNREFUSED'));
      axiosGet.mockResolvedValue(ok(ROOFTOP));
      expect(await geocodeAddress(ELIGIBLE, 'Kerkstraat 12')).toMatchObject({ status: 'placed' });
    });
  });
});
