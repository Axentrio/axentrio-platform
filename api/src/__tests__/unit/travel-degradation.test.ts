/**
 * #68 — knowing when travel checking has stopped working.
 *
 * The rules here were each arrived at by getting them wrong first, over four review rounds, and
 * every one of them is a way the monitor could rebuild the silence it exists to end. They are
 * tested as rules rather than as code paths for that reason.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
const redis = {
  incr: vi.fn(async (k: string) => {
    const next = (Number(store.get(k)) || 0) + 1;
    store.set(k, String(next));
    return next;
  }),
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  expire: vi.fn(async () => 1),
  set: vi.fn(async (k: string, v: string, mode?: string) => {
    if (mode === 'NX' && store.has(k)) return null;
    store.set(k, v);
    return 'OK';
  }),
  del: vi.fn(async (...keys: string[]) => {
    let n = 0;
    for (const k of keys) if (store.delete(k)) n += 1;
    return n;
  }),
  keys: vi.fn(async () => [...store.keys()]),
};
vi.mock('../../config/redis', () => ({
  getRedisClient: () => redis,
  isRedisAvailable: () => true,
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type AlertMail = { to: string; subject: string; body: string };
const send = vi.fn(async (_mail: AlertMail) => undefined);
vi.mock('../../automations', () => ({ getEmailService: () => ({ send }) }));

/** The nth alert, or a failure that says which one was missing rather than `undefined`. */
const mail = (n = 0): AlertMail => {
  const call = send.mock.calls[n];
  if (!call) throw new Error(`expected an alert #${n}, but ${send.mock.calls.length} were sent`);
  return call[0];
};

const post = vi.fn();
vi.mock('axios', () => ({
  default: { post: (...a: unknown[]) => post(...a), isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError },
}));

// `config` snapshots the environment at module load, so a test that deletes the variable would
// otherwise be testing the value the suite started with. Made live, so "no key" is a state a test
// can actually put the probe into.
vi.mock('../../config/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/environment')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      travel: {
        ...actual.config.travel,
        get googleMapsApiKey() {
          return process.env.GOOGLE_MAPS_API_KEY;
        },
      },
    },
  };
});

import {
  classifyCause,
  recordCause,
  recordRoutingSuccess,
  platformFailures,
  routingSuccesses,
  metricCounts,
  PLATFORM_THRESHOLD,
} from '../../booking/travel/degradation-monitor';
import { runTravelHealthCheck, reconcileObservedDegradation, __resetTravelHealthState } from '../../booking/travel/travel-health';
import { logger } from '../../utils/logger';

/** What Google answers when routing works. */
const PROBE_OK = { data: [{ condition: 'ROUTE_EXISTS', duration: '3400s' }] };

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  __resetTravelHealthState();
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  // `clearAllMocks` clears CALLS but keeps implementations, so a `mockRejectedValue` set in one
  // test would otherwise still be in force in the next one and decide its result. Reset and pin a
  // healthy default: a test that wants a failure has to ask for it.
  post.mockReset();
  post.mockResolvedValue(PROBE_OK);
});

describe('which causes are faults', () => {
  it.each([
    ['no_api_key', 'platform'],
    ['api_error', 'platform'],
    ['malformed_response', 'platform'],
    ['cap_exhausted', 'tenant'],
    ['shared_itinerary', 'configuration'],
  ])('%s is a %s fault', (cause, cls) => {
    expect(classifyCause(cause)).toBe(cls);
  });

  it('settled_by_bounds is NOT a fault — it is the floor doing its job', () => {
    // The #64 lesson, in the form it keeps coming back in. `degraded` is provenance, and a
    // monitor that treated this as a failure would flag most of a good day.
    expect(classifyCause('settled_by_bounds')).toBe('none');
  });

  it('departed is NOT a fault — the slot went stale mid-conversation', () => {
    expect(classifyCause('departed')).toBe('none');
  });

  it.each(['no_route', 'budget_spent'])('%s is counted but never paged', (cause) => {
    // Not nothing, and not an alert. One `no_route` is a geocode in a canal; a sustained RATE
    // is an upstream regression worth seeing without waking anybody.
    expect(classifyCause(cause)).toBe('metric');
  });

  it('records a metric cause without touching the platform counter', async () => {
    await recordCause('no_route');
    expect((await metricCounts()).no_route).toBe(1);
    expect(await platformFailures()).toBe(0);
  });

  it('records nothing at all for a non-fault', async () => {
    await recordCause('settled_by_bounds');
    await recordCause('departed');
    expect(await platformFailures()).toBe(0);
    expect(Object.values(await metricCounts()).every((n) => n === 0)).toBe(true);
  });
});

describe('the probe answers what observation cannot', () => {
  const routeOk = PROBE_OK;

  it('alerts when routing is down, and says bookings are still being taken', async () => {
    post.mockRejectedValue({ isAxiosError: true, response: { status: 500, data: 'boom' } });
    await runTravelHealthCheck();

    expect(send).toHaveBeenCalledTimes(1);
    const body = String(mail().body);
    // AC-4: the alert says what is happening and what to do, not that a counter moved.
    expect(body).toMatch(/still being taken/i);
    expect(body).toMatch(/distance/i);
    // Google was actually asked. Without this the test passes on the no-key branch too, which is
    // how it passed before the mock above made the key real — the three failure states share a
    // body and differ only in the cause line.
    expect(post).toHaveBeenCalledTimes(1);
    expect(body).toMatch(/unreachable or answered unusably/i);
  });

  it('asks Google the way production does — TRAFFIC_AWARE, or it watches a path nobody takes', () => {
    // A cheaper traffic-unaware probe bills a different SKU and would stay green through exactly
    // the Pro quota and billing failures that break every real booking.
    post.mockResolvedValue(routeOk);
    return runTravelHealthCheck().then(() => {
      expect(post.mock.calls[0]?.[1]).toMatchObject({ routingPreference: 'TRAFFIC_AWARE' });
    });
  });

  it('separates a REFUSAL from an outage, because the responses differ', async () => {
    post.mockRejectedValue({ isAxiosError: true, response: { status: 403, data: 'denied' } });
    await runTravelHealthCheck();
    expect(String(mail().body)).toMatch(/billing account|key restrictions/i);
  });

  it('answers a missing key without calling Google at all', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const health = await runTravelHealthCheck();
    expect(health.state).toBe('no_key');
    expect(post).not.toHaveBeenCalled();
  });

  it('alerts ONCE while the outage stands, not every tick', async () => {
    post.mockRejectedValue({ isAxiosError: true, response: { status: 500, data: 'boom' } });
    await runTravelHealthCheck();
    await runTravelHealthCheck();
    await runTravelHealthCheck();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('announces recovery on a SUCCESSFUL probe, then re-arms', async () => {
    post.mockRejectedValue({ isAxiosError: true, response: { status: 500, data: 'boom' } });
    await runTravelHealthCheck();
    post.mockResolvedValue(routeOk);
    await runTravelHealthCheck();
    expect(send).toHaveBeenCalledTimes(2);
    expect(String(mail(1).subject)).toMatch(/recovered/i);

    // Re-armed: a second outage alerts again rather than being swallowed by the old latch.
    post.mockRejectedValue({ isAxiosError: true, response: { status: 500, data: 'boom' } });
    await runTravelHealthCheck();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('is silent while healthy', async () => {
    post.mockResolvedValue(routeOk);
    await runTravelHealthCheck();
    expect(send).not.toHaveBeenCalled();
  });

  it('an alert nobody can deliver is still findable, and does not take the checker down with it', async () => {
    // `provider-health`'s rule. A watchdog whose only output channel is broken has to leave
    // something behind, and it must not throw inside a scheduler tick where nothing catches it.
    post.mockRejectedValue({ isAxiosError: true, response: { status: 500, data: 'boom' } });
    send.mockRejectedValueOnce(new Error('SMTP refused'));

    await expect(runTravelHealthCheck()).resolves.toMatchObject({ state: 'unreachable' });
    expect(logger.error).toHaveBeenCalledWith(
      '[travel-health] ALERT DELIVERY FAILED',
      expect.objectContaining({ error: 'SMTP refused' })
    );
  });
});

describe('observed degradation is its own incident, with its own recovery', () => {
  const observePlatformFailures = async (n: number) => {
    for (let i = 0; i < n; i += 1) await recordCause('api_error');
  };

  it('does not alert on one bad request', async () => {
    await recordCause('api_error');
    await reconcileObservedDegradation();
    expect(send).not.toHaveBeenCalled();
  });

  it('alerts once the failures are sustained', async () => {
    await observePlatformFailures(PLATFORM_THRESHOLD);
    await reconcileObservedDegradation();
    expect(send).toHaveBeenCalledTimes(1);
    // It must say the probe may still look fine, or the operator checks the wrong thing.
    expect(String(mail().body)).toMatch(/probe may still be healthy/i);
  });

  it('does NOT clear on a quiet window — silence is what no traffic looks like', async () => {
    // The defect this rule exists for. An all-clear that had not happened would oscillate for
    // as long as the real failure lasted, and teach the operator the alarm is noise.
    await observePlatformFailures(PLATFORM_THRESHOLD);
    await reconcileObservedDegradation();
    send.mockClear();

    store.delete('travel:degradation:platform'); // the window expired, no new traffic
    await reconcileObservedDegradation();
    expect(send).not.toHaveBeenCalled();
  });

  it('clears only on a routed request that ANSWERED', async () => {
    await observePlatformFailures(PLATFORM_THRESHOLD);
    await reconcileObservedDegradation();
    send.mockClear();

    await recordRoutingSuccess();
    expect(await routingSuccesses()).toBe(1);
    await reconcileObservedDegradation();
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(mail().subject)).toMatch(/recovered/i);
  });

  it('a healthy PROBE does not clear an incident real traffic raised', async () => {
    // The two latches are independent, and this is why. The probe checks one fixed journey; a
    // regional or request-shaped failure can break real bookings while it stays green. Letting
    // it clear would announce a recovery that had not happened.
    await observePlatformFailures(PLATFORM_THRESHOLD);
    await reconcileObservedDegradation();
    send.mockClear();

    post.mockResolvedValue({ data: [{ condition: 'ROUTE_EXISTS' }] });
    await runTravelHealthCheck();

    expect(send).not.toHaveBeenCalled();
    expect(store.has('travel:health:incident:observed')).toBe(true);
  });
});
