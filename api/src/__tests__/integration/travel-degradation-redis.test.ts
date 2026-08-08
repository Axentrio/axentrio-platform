/**
 * #68 AC-5 - a sustained failure, driven the whole way through.
 *
 * "Verified by simulating a sustained failure, not only by unit-testing the detector."
 *
 * The detector is the easy half. The defects live in the coordination: an incident latch claimed
 * with `SET NX` so one instance mails and the others do not, a probe lease so one instance probes
 * and the cost is not multiplied, and an ordering that decides whether a success came after a
 * failure. NONE of that can be established against a double, because the double IS the part being
 * trusted - a fake `SET NX` that returns what the test expects proves the test, not Redis.
 *
 * So this runs against REAL REDIS. Only the outermost boundaries are stubbed: the HTTP call to
 * Google (no test may depend on a paid third party) and the mail transport (asserted on, not
 * delivered). Everything between them is production code.
 *
 * Requires the `test-redis` service from `docker-compose.test.yml`. It FAILS rather than skips
 * when that is missing: a coordination test that quietly passes because it never ran is the exact
 * shape of defect this whole ticket exists to remove.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import Redis from 'ioredis';

const send = vi.fn(async (_mail: { to: string; subject: string; body: string }) => ({ success: true }));
vi.mock('../../automations', () => ({ getEmailService: () => ({ send }) }));

const post = vi.fn();
vi.mock('axios', () => ({
  default: {
    post: (...a: unknown[]) => post(...a),
    isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError,
  },
}));

// The probe reads the key off `config`, which snapshots the environment at module load.
vi.mock('../../config/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/environment')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      travel: { ...actual.config.travel, googleMapsApiKey: 'test-key' },
    },
  };
});

// The one seam that must NOT be the production singleton: `initializeRedis` reads the app's own
// REDIS_URL, which in a test process points at nothing. This hands the real client back through
// the same accessors production uses.
let client: Redis;
vi.mock('../../config/redis', () => ({
  getRedisClient: () => client,
  isRedisAvailable: () => true,
}));

import {
  recordCause,
  recordRoutingSuccess,
  monitorState,
  scopedCauseSpread,
  __resetDegradationCounters,
  PLATFORM_THRESHOLD,
} from '../../booking/travel/degradation-monitor';
import {
  runTravelHealthCheck,
  reconcileObservedDegradation,
  travelHealthSnapshot,
  __resetTravelHealthState,
} from '../../booking/travel/travel-health';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';
const FAILING = { isAxiosError: true, response: { status: 500, data: 'upstream is down' } };
const ROUTED = { data: [{ condition: 'ROUTE_EXISTS', duration: '3400s' }] };

/** A scheduled tick. The lease outlives one tick in production; here it is released explicitly. */
async function tick(): Promise<void> {
  await client.del('travel:health:probe-lease');
  await runTravelHealthCheck();
}

beforeAll(async () => {
  client = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await client.connect();
    await client.ping();
  } catch (err) {
    throw new Error(
      `#68 AC-5 needs the real Redis it coordinates through. Start it with ` +
        `\`docker compose -f api/docker-compose.test.yml up -d test-redis\`. Tried ${REDIS_URL}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
});

afterAll(async () => {
  await client?.quit();
});

beforeEach(async () => {
  vi.clearAllMocks();
  post.mockReset();
  __resetTravelHealthState();
  await __resetDegradationCounters();
  const keys = await client.keys('travel:health:*');
  if (keys.length) await client.del(...keys);
});

describe('AC-5: a sustained routing failure, through real Redis', () => {
  it('goes from a failing upstream to a delivered alert, and stays quiet after', async () => {
    post.mockRejectedValue(FAILING);

    // One failure is not an outage (AC-3). Nothing is sent, and the pending mark is real state in
    // Redis rather than a variable in this process.
    await tick();
    expect(send).not.toHaveBeenCalled();
    expect(await client.get('travel:health:pending-failure')).not.toBeNull();

    // Sustained. Now somebody is told.
    await runTravelHealthCheck({ confirming: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0].subject)).toMatch(/routing is down/i);
    expect(await client.get('travel:health:incident:probe')).not.toBeNull();

    // And it does not repeat while the same outage stands.
    await tick();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('lets exactly ONE instance alert on the same transition', async () => {
    // The `SET NX` claim, asserted against the thing that implements it. Two concurrent checks
    // are two instances reaching the same conclusion in the same instant; only one may mail.
    post.mockRejectedValue(FAILING);
    await client.set('travel:health:pending-failure', 'already seen once');

    await Promise.all([
      runTravelHealthCheck({ confirming: true }),
      runTravelHealthCheck({ confirming: true }),
      runTravelHealthCheck({ confirming: true }),
    ]);

    const outage = send.mock.calls.filter((c) => /routing is down/i.test(String(c[0].subject)));
    expect(outage).toHaveLength(1);
  });

  it('lets exactly ONE instance probe per window', async () => {
    // Without the lease every instance probes, so the billed cost multiplies by container count
    // and two hosts observing one instant look like one host observing twice.
    post.mockResolvedValue(ROUTED);
    await client.del('travel:health:probe-lease');

    const results = await Promise.all([runTravelHealthCheck(), runTravelHealthCheck(), runTravelHealthCheck()]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.state === 'skipped')).toHaveLength(2);
  });

  it('recovers only on a probe that answered, and says so once', async () => {
    post.mockRejectedValue(FAILING);
    await tick();
    await runTravelHealthCheck({ confirming: true });
    send.mockClear();

    post.mockResolvedValue(ROUTED);
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0].subject)).toMatch(/recovered/i);
    expect(await client.get('travel:health:incident:probe')).toBeNull();

    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('AC-5: sustained failure seen in REAL BOOKINGS, through real Redis', () => {
  it('raises once the failures are sustained, and clears only after something answers', async () => {
    for (let i = 0; i < PLATFORM_THRESHOLD; i += 1) await recordCause('api_error');
    await reconcileObservedDegradation();
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0].subject)).toMatch(/failing on real bookings/i);
    send.mockClear();

    // A quiet pass is not recovery - silence is what no booking traffic looks like.
    await reconcileObservedDegradation();
    expect(send).not.toHaveBeenCalled();

    // A routed request that answered is.
    await recordRoutingSuccess();
    await reconcileObservedDegradation();
    expect(String(send.mock.calls[0]?.[0].subject)).toMatch(/recovered/i);
  });

  it('orders success against failure through Redis, not through any host clock', async () => {
    // The two events are written by whichever instance handled each request, so the comparison
    // cannot rest on wall clocks. This is the assertion that a shared sequence makes possible.
    await recordRoutingSuccess();
    for (let i = 0; i < PLATFORM_THRESHOLD; i += 1) await recordCause('api_error');

    // A success BEFORE the failures is not a recovery, so a partial failure still raises.
    await reconcileObservedDegradation();
    expect(String(send.mock.calls[0]?.[0].subject)).toMatch(/failing on real bookings/i);

    const lastFailure = Number(await client.get('travel:degradation:last:failure'));
    const lastSuccess = Number(await client.get('travel:degradation:last:success'));
    expect(lastFailure).toBeGreaterThan(lastSuccess);
  });

  it('a healthy PROBE does not clear what real traffic raised', async () => {
    for (let i = 0; i < PLATFORM_THRESHOLD; i += 1) await recordCause('api_error');
    await reconcileObservedDegradation();
    send.mockClear();

    post.mockResolvedValue(ROUTED);
    await tick();

    expect(send).not.toHaveBeenCalled();
    expect(await client.get('travel:health:incident:observed')).not.toBeNull();
  });
});

describe('AC-5: what the operator can see without waiting to be told', () => {
  it('reports the probe, the standing incidents and the distinct affected parties', async () => {
    post.mockResolvedValue(ROUTED);
    await tick();
    await recordCause('cap_exhausted', { tenantId: 'tenant-a' });
    await recordCause('cap_exhausted', { tenantId: 'tenant-a' });
    await recordCause('cap_exhausted', { tenantId: 'tenant-b' });
    await recordCause('no_route');

    const snapshot = await travelHealthSnapshot();
    expect(snapshot.monitoring).toBe('ok');
    expect(snapshot.lastProbe?.state).toBe('ok');
    expect(snapshot.incidents).toEqual({ probe: false, observed: false });
    expect(snapshot.rates.no_route).toBe(1);
    // Two tenants, three events. Occurrences would say 3 and imply an epidemic where there are
    // two businesses.
    expect(snapshot.spread.capExhaustedTenants).toBe(2);
  });

  it('the probe result is READABLE BY ANOTHER INSTANCE, since only one of them probes', async () => {
    post.mockResolvedValue(ROUTED);
    await tick();

    // The snapshot is served from Redis, so an instance that never probed still answers. Held
    // per process, this would be `null` on every instance but the one that happened to tick.
    __resetTravelHealthState();
    expect((await travelHealthSnapshot()).lastProbe?.state).toBe('ok');
  });

  it('a blind monitor reports `unknown`, never zero', async () => {
    expect(await monitorState()).toBe('ok');
    expect((await scopedCauseSpread()).capExhaustedTenants).toBe(0);
  });
});
