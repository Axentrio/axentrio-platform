/**
 * The Routes client. Three things are worth pinning here and the rest is plumbing: that a
 * paid call is never made when a cheaper answer exists, that the cache key carries everything
 * that changes the answer, and that every way Google can disappoint us degrades rather than
 * refusing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { travelConfig, axiosPost, redisGet, redisSet, reserve } = vi.hoisted(() => ({
  travelConfig: { googleMapsApiKey: 'key-1' as string | undefined, monthlyElementCapPerTenant: 5000 },
  axiosPost: vi.fn(),
  redisGet: vi.fn(async (..._a: unknown[]) => null as string | null),
  redisSet: vi.fn(async (..._a: unknown[]) => 'OK'),
  reserve: vi.fn(async (..._a: unknown[]) => true),
}));

vi.mock('../../config/environment', () => ({ config: { travel: travelConfig } }));
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => axiosPost(...a) } }));
vi.mock('../../config/redis', () => ({ getRedisClient: () => ({ get: redisGet, set: redisSet }) }));
vi.mock('../../booking/travel/travel-usage.service', () => ({
  reserveTravelElements: (...a: unknown[]) => reserve(...a),
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { driveMinutes, driveCacheKey, departureBucket } from '../../booking/travel/routes.service';
import type { ActiveTravelEligibility } from '../../booking/travel/travel-eligibility';

const ELIGIBLE: ActiveTravelEligibility = {
  active: true,
  tenantId: 'ten-1',
  itineraryKey: 'gcal:owner@acme.com',
  slackMin: 0,
  startFromBase: false,
};

const ANTWERP = { lat: 51.2194, lng: 4.4025 };
const BRUSSELS = { lat: 50.8503, lng: 4.3517 };

const NOW = new Date('2026-06-10T08:00:00Z');
const soon = (): Date => new Date(NOW.getTime() + 3 * 60 * 60 * 1000); // +3h → traffic-aware
const distant = (): Date => new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000); // +5d → not

const ok = (duration: string) => ({ data: [{ originIndex: 0, destinationIndex: 0, duration, condition: 'ROUTE_EXISTS', status: {} }] });

const call = (departAt: Date, sessionId: string | null = 'sess-1') =>
  driveMinutes(ELIGIBLE, { from: ANTWERP, to: BRUSSELS, departAt, sessionId });

describe('routes.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    travelConfig.googleMapsApiKey = 'key-1';
    redisGet.mockResolvedValue(null);
    reserve.mockResolvedValue(true);
    axiosPost.mockResolvedValue(ok('3317s'));
  });

  it('returns the routed duration, rounded UP to the minute', async () => {
    // Rounding a drive DOWN is the direction that authorises a booking the owner cannot make.
    axiosPost.mockResolvedValue(ok('3317s')); // 55.28 min
    expect(await call(soon())).toEqual({ status: 'routed', minutes: 56 });
  });

  it('never calls Google without a platform key, and reserves nothing', async () => {
    travelConfig.googleMapsApiKey = undefined;
    expect(await call(soon())).toEqual({ status: 'unavailable', cause: 'no_api_key' });
    expect(reserve).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('refuses to spend when the tenant has no elements left', async () => {
    reserve.mockResolvedValue(false);
    expect(await call(soon())).toEqual({ status: 'unavailable', cause: 'cap_exhausted' });
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('reserves BEFORE the request, because Google bills the request and not the answer', async () => {
    const order: string[] = [];
    reserve.mockImplementation(async () => {
      order.push('reserve');
      return true;
    });
    axiosPost.mockImplementation(async () => {
      order.push('post');
      return ok('600s');
    });
    await call(soon());
    expect(order).toEqual(['reserve', 'post']);
  });

  it('does not ask about a departure that has already passed', async () => {
    // Google rejects a past departureTime. A candidate slot going stale mid-conversation is a
    // normal race, so it degrades rather than erroring.
    expect(await call(new Date(NOW.getTime() - 60_000))).toEqual({ status: 'unavailable', cause: 'departed' });
    expect(reserve).not.toHaveBeenCalled();
  });

  describe('traffic horizon', () => {
    it('asks for traffic inside ~24h, and says when it is leaving', async () => {
      await call(soon());
      const body = axiosPost.mock.calls[0][1] as Record<string, unknown>;
      expect(body.routingPreference).toBe('TRAFFIC_AWARE');
      expect(body.departureTime).toBe(soon().toISOString());
    });

    it('does NOT ask for traffic beyond it — that is the Pro SKU buying a historical average', async () => {
      await call(distant());
      const body = axiosPost.mock.calls[0][1] as Record<string, unknown>;
      expect(body.routingPreference).toBeUndefined();
      expect(body.departureTime).toBeUndefined();
    });
  });

  describe('the cache key', () => {
    it('separates traffic-aware from traffic-unaware for the same pair and time', () => {
      const base = { sessionId: 's', from: ANTWERP, to: BRUSSELS, bucket: 7 };
      expect(driveCacheKey({ ...base, trafficAware: true })).not.toBe(
        driveCacheKey({ ...base, trafficAware: false })
      );
    });

    it('separates departure buckets, so a rush-hour answer cannot be replayed at 2pm', () => {
      const base = { sessionId: 's', from: ANTWERP, to: BRUSSELS, trafficAware: true };
      expect(driveCacheKey({ ...base, bucket: 7 })).not.toBe(driveCacheKey({ ...base, bucket: 8 }));
    });

    it('separates conversations, because that is the only scope the licence allows', () => {
      const base = { from: ANTWERP, to: BRUSSELS, trafficAware: true, bucket: 7 };
      expect(driveCacheKey({ ...base, sessionId: 'a' })).not.toBe(driveCacheKey({ ...base, sessionId: 'b' }));
    });

    it('buckets traffic-aware by quarter hour and collapses traffic-unaware to a constant', () => {
      const t = new Date('2026-06-10T09:07:00Z');
      expect(departureBucket(t, true)).toBe(departureBucket(new Date('2026-06-10T09:14:59Z'), true));
      expect(departureBucket(t, true)).not.toBe(departureBucket(new Date('2026-06-10T09:16:00Z'), true));
      // Time-independent, so a whole day of far-future candidates costs one element.
      expect(departureBucket(t, false)).toBe(departureBucket(distant(), false));
    });
  });

  it('answers a cache hit without reserving or calling', async () => {
    redisGet.mockResolvedValue(JSON.stringify({ status: 'routed', minutes: 42 }));
    expect(await call(soon())).toEqual({ status: 'routed', minutes: 42 });
    expect(reserve).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('neither reads nor writes a cache without a conversation to scope it to', async () => {
    await call(soon(), null);
    expect(redisGet).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
    expect(axiosPost).toHaveBeenCalledOnce();
  });

  it('does NOT cache an outage — that is a fact about this moment, not about the pair', async () => {
    axiosPost.mockRejectedValue(new Error('ETIMEDOUT'));
    expect(await call(soon())).toEqual({ status: 'unavailable', cause: 'api_error' });
    expect(redisSet).not.toHaveBeenCalled();
  });

  describe('what Google can come back with', () => {
    it('treats ROUTE_NOT_FOUND as a definite no about the pair', async () => {
      axiosPost.mockResolvedValue({ data: [{ condition: 'ROUTE_NOT_FOUND', status: {} }] });
      expect(await call(soon())).toEqual({ status: 'no_route' });
    });

    it('degrades on a per-element error rather than refusing the slot', async () => {
      // Google reporting a problem with THIS pair is not the same as no route existing.
      axiosPost.mockResolvedValue({ data: [{ status: { code: 3, message: 'bad' } }] });
      expect(await call(soon())).toEqual({ status: 'unavailable', cause: 'api_error' });
    });

    it('refuses to coerce an unreadable duration', async () => {
      // A NaN here would sail through the gap arithmetic as "no constraint at all".
      for (const duration of ['', 'later', '12', '-5s', undefined]) {
        axiosPost.mockResolvedValue({ data: [{ duration, condition: 'ROUTE_EXISTS', status: {} }] });
        expect(await call(soon())).toEqual({ status: 'unavailable', cause: 'malformed_response' });
      }
    });

    it('degrades on an empty matrix', async () => {
      axiosPost.mockResolvedValue({ data: [] });
      expect(await call(soon())).toEqual({ status: 'unavailable', cause: 'malformed_response' });
    });
  });
});
