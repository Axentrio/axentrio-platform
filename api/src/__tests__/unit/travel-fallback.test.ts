/**
 * When Google breaks, an estimate arrives. When we DECLINED to ask, nothing does.
 *
 * That one distinction carries the whole safety of the free estimator, and it is invisible from
 * either side on its own: `driveLookupFor` returns the same shape whether Google failed or whether
 * policy stopped us calling it, so the only place the difference exists is the branch under test
 * here. Get it wrong in the permissive direction and a spent cap stops meaning anything, because
 * every capped leg quietly answers from geometry instead. Get it wrong in the other and the
 * estimator never fires at all, which is the outage it was built for.
 *
 * `sessionId` is null throughout, so no cache key is formed and Redis is never reached. The
 * failure being exercised is Google's, and a cache in the way would only make it ambiguous.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reserveTravelElements = vi.fn();
const post = vi.fn();

vi.mock('axios', () => ({ default: { post: (...args: unknown[]) => post(...args) } }));
vi.mock('../../booking/travel/travel-usage.service', () => ({ reserveTravelElements }));
vi.mock('../../config/environment', async () => {
  const actual = await vi.importActual<typeof import('../../config/environment')>('../../config/environment');
  // Without a key `driveMinutes` returns `no_api_key` before it reaches anything, and every test
  // below would pass while testing nothing.
  return { ...actual, config: { ...actual.config, travel: { ...actual.config.travel, googleMapsApiKey: 'k' } } };
});

const eligibility = {
  active: true as const,
  tenantId: 'tenant-1',
  itineraryKey: 'bot:1',
  slackMin: 0,
  startFromBase: false,
  maxDetourMin: null,
  baseDepartOffsetMin: 0,
  groupingPeriod: 'none' as const, routePriority: 'auto' as const,
};

// Antwerp to Ghent: far enough apart that an estimate is a real number rather than the overhead
// term on its own, which would make the assertions below true for the wrong reason.
const leg = {
  from: { lat: 51.2213, lng: 4.3997 },
  to: { lat: 51.0543, lng: 3.7226 },
  budgetMin: 600,
  departAt: new Date(Date.now() + 3_600_000),
};

const lookup = async (opts?: Parameters<typeof import('../../booking/travel/routes.service').driveLookupFor>[2]) => {
  const { driveLookupFor } = await import('../../booking/travel/routes.service');
  return driveLookupFor(eligibility, null, opts)(leg);
};

beforeEach(() => {
  vi.resetModules();
  reserveTravelElements.mockReset().mockResolvedValue(true);
  post.mockReset();
});

describe('Google was asked and broke', () => {
  it('answers from geometry when the request itself fails', async () => {
    post.mockRejectedValue(new Error('ECONNRESET'));

    const answer = await lookup();

    expect(answer.minutes).not.toBeNull();
    expect(answer.estimated).toBe(true);
    // The cause is Google's, not the estimator's. #68 counts outages, and an outage that reported
    // itself as `estimated` would vanish from the health signal the moment the fallback shipped.
    expect(answer.cause).toBe('api_error');
  });

  it('answers from geometry when the element carries an error', async () => {
    // HTTP 200 with a per-element failure - the shape an outage takes when the transport is fine.
    post.mockResolvedValue({ data: [{ status: { code: 3 } }] });

    const answer = await lookup();

    expect(answer.estimated).toBe(true);
    expect(answer.cause).toBe('api_error');
  });

  it('pads what it returns, so a fallback cannot clear a journey it under-states', async () => {
    const { estimateDriveMinutes } = await import('../../booking/travel/haversine-lookup');
    post.mockRejectedValue(new Error('ECONNRESET'));

    const answer = await lookup();

    expect(answer.minutes!).toBeGreaterThan(estimateDriveMinutes(leg.from, leg.to));
  });
});

describe('we declined to ask', () => {
  it('stays silent on a spent cap, so the cap keeps meaning something', async () => {
    // The permissive bug lives here. An estimate arriving on `cap_exhausted` would let a tenant
    // past their own ceiling for free, and nothing would report it.
    reserveTravelElements.mockResolvedValue(false);

    const answer = await lookup();

    expect(answer.minutes).toBeNull();
    expect(answer.estimated).toBeUndefined();
    expect(answer.cause).toBe('cap_exhausted');
  });

  it('stays silent for a cache-only reader, which is what keeps grouping out of the budget', async () => {
    const answer = await lookup({ cacheOnly: true });

    expect(answer.minutes).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(answer.cause).toBe('not_cached');
  });

  it('stays silent past the deadline, having already abandoned the wait', async () => {
    const answer = await lookup({ notAfter: Date.now() - 1 });

    expect(answer.minutes).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('stays silent when Google found no route, because that is a refusal and not a failure', async () => {
    post.mockResolvedValue({ data: [{ condition: 'ROUTE_NOT_FOUND' }] });

    const answer = await lookup();

    // Substituting an estimate here would say a drive is possible that Google says has no road.
    expect(answer.minutes).toBeNull();
    expect(answer.cause).toBe('no_route');
  });
});
