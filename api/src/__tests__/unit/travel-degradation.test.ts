/**
 * #68 - knowing when travel checking has stopped working.
 *
 * The rules here were each arrived at by getting them wrong first, over four review rounds, and
 * every one of them is a way the monitor could rebuild the silence it exists to end. They are
 * tested as rules rather than as code paths for that reason.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
const sets = new Map<string, Set<string>>();
const redis = {
  incr: vi.fn(async (k: string) => {
    const next = (Number(store.get(k)) || 0) + 1;
    store.set(k, String(next));
    return next;
  }),
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  expire: vi.fn(async () => 1),
  set: vi.fn(async (k: string, v: string, ...opts: unknown[]) => {
    if (opts.includes('NX') && store.has(k)) return null;
    store.set(k, v);
    return 'OK';
  }),
  del: vi.fn(async (...keys: string[]) => {
    let n = 0;
    for (const k of keys) if (store.delete(k)) n += 1;
    return n;
  }),
  keys: vi.fn(async () => [...store.keys()]),
  sadd: vi.fn(async (k: string, member: string) => {
    const set = sets.get(k) ?? new Set<string>();
    const had = set.has(member);
    set.add(member);
    sets.set(k, set);
    return had ? 0 : 1;
  }),
  scard: vi.fn(async (k: string) => sets.get(k)?.size ?? 0),
};
/** Thrown by the tests that assert what happens when the monitor goes blind. */
let redisDown = false;
vi.mock('../../config/redis', () => ({
  getRedisClient: () => (redisDown ? null : redis),
  isRedisAvailable: () => !redisDown,
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type AlertMail = { to: string; subject: string; body: string };
type SendResult = { success: boolean; error?: string };
// The REAL shape. `EmailService.send` reports a failed delivery by RETURNING `{success:false}`,
// not by throwing, so a mock resolving to `undefined` would let a broken-mail bug pass every
// assertion here.
const send = vi.fn(async (_mail: AlertMail): Promise<SendResult> => ({ success: true }));
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
  scopedCauseSpread,
  PLATFORM_THRESHOLD,
  CAUSE_CLASS,
  type CauseClass,
  type DegradationCause,
} from '../../booking/travel/degradation-monitor';
import {
  runTravelHealthCheck,
  reconcileObservedDegradation,
  travelHealthSnapshot,
  __resetTravelHealthState,
} from '../../booking/travel/travel-health';
import { logger } from '../../utils/logger';

/** A scheduled tick: release the probe lease first, the way its 20-minute expiry does in
 *  production against a 30-minute cadence. */
const tickTop = async () => {
  store.delete('travel:health:probe-lease');
  return runTravelHealthCheck();
};

/** What Google answers when routing works. */
const PROBE_OK = { data: [{ condition: 'ROUTE_EXISTS', duration: '3400s' }] };

beforeEach(() => {
  store.clear();
  sets.clear();
  vi.clearAllMocks();
  __resetTravelHealthState();
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  // `clearAllMocks` clears CALLS but keeps implementations, so a `mockRejectedValue` set in one
  // test would otherwise still be in force in the next one and decide its result. Reset and pin a
  // healthy default: a test that wants a failure has to ask for it.
  post.mockReset();
  post.mockResolvedValue(PROBE_OK);
  redisDown = false;
});

/**
 * The classes this suite claims each cause deserves, restated by hand.
 *
 * Deliberately NOT derived from `CAUSE_CLASS` - a test that reads the map it is checking asserts
 * only that the map equals itself. This is a second, independent statement of the same judgement,
 * so changing production without meaning to goes red here, and changing it on purpose costs one
 * line and a moment's thought about who gets woken up.
 */
const EXPECTED_CLASS: Record<string, CauseClass> = {
  // Platform: an outage, and nobody's fault but ours to chase.
  no_api_key: 'platform',
  api_error: 'platform',
  malformed_response: 'platform',
  // Address suggestions, reported since launch and classified nowhere until #93. Places API (New)
  // was never enabled on production, so every autocomplete returned `api_error` and the fail-open
  // made it look like a query that matched nothing.
  places_api_error: 'platform',
  places_cap_exhausted: 'tenant',
  // Definite states about one business, notified on first occurrence rather than on a threshold.
  cap_exhausted: 'tenant',
  shared_itinerary: 'configuration',
  // Counted, never mailed. One is ordinary; a sustained rate is a regression.
  no_route: 'metric',
  budget_spent: 'metric',
  // "Something failed and we do not know what" - the one cause that MUST NOT be silent, because a
  // nameless failure is the one nothing else will report. It was 'none' until this change.
  unknown: 'metric',
  // Not faults. Each is a decision, and each would flag a good day if treated as an alarm (#64).
  settled_by_bounds: 'none',
  departed: 'none',
  not_cached: 'none',
  estimated: 'none',
};

/**
 * WHAT THIS BLOCK IS FOR, NOW THAT IT IS NOT WHAT IT USED TO BE.
 *
 * It used to carry a test called "classifies every cause the codebase actually reports", holding a
 * hardcoded list of five literals. That test existed to catch the next unclassified cause, and it
 * could not: the list was written by hand, so a new cause reaching `recordCause` was also a new
 * cause missing from the list, and the test went green either way. It was the one thing it existed
 * to prevent, and it named five of the fourteen causes that actually reach the monitor.
 *
 * The omission check is the COMPILER's now. `recordCause` and `classifyCause` take
 * `DegradationCause`, and every producer is typed with it - `RoutedLeg.cause`, the gate's cause
 * set, `degradedCauses`, the routes client's union - so a literal that is not in `CAUSE_CLASS`
 * fails `tsc --noEmit`. Vitest does not type-check, so no test in this file can observe that; the
 * build does.
 *
 * What is left for these tests is the half a type cannot state: WHICH class each cause belongs to.
 * `cap_exhausted` being `tenant` rather than `platform` is a judgement about who gets woken up, and
 * getting it wrong compiles perfectly.
 */
describe('which causes are faults', () => {
  it('every cause in the map is exercised below', () => {
    // Not an omission check - the compiler does that. This one catches the opposite drift: a
    // cause ADDED to the map and classified by nobody's deliberate decision, which is how a
    // literal ends up with a class chosen by whichever line it was pasted next to.
    const asserted = new Set(Object.keys(EXPECTED_CLASS));
    expect(Object.keys(CAUSE_CLASS).filter((c) => !asserted.has(c))).toEqual([]);
  });

  it.each(Object.entries(EXPECTED_CLASS))('%s is classified %s', (cause, cls) => {
    expect(classifyCause(cause as DegradationCause)).toBe(cls);
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

  /**
   * The next SCHEDULED tick.
   *
   * Only one instance probes per window, and the lease that arranges it lives for 20 minutes
   * against a 30-minute cadence - so in production it has expired by the time the next tick
   * arrives. The double has no clock, so the tick is what releases it. Calling
   * `runTravelHealthCheck()` twice without this models two instances racing in one window, not
   * two ticks, and would be answered with `skipped`.
   */
  const tick = async () => {
    store.delete('travel:health:probe-lease');
    return runTravelHealthCheck();
  };

  /**
   * A failing probe, observed TWICE.
   *
   * AC-3 forbids alerting on a single transient failure, so one failing tick only records a
   * pending failure and schedules a confirmation. Every test that wants a raised incident has to
   * go through that, which is the point: if the confirmation rule were removed, `expect(send)
   * .toHaveBeenCalledTimes(1)` here would become 2 and these tests would fail.
   */
  const confirmedOutage = async (status = 500) => {
    post.mockRejectedValue({ isAxiosError: true, response: { status, data: 'boom' } });
    await tick();
    await runTravelHealthCheck({ confirming: true });
  };

  it('does NOT alert on one failing probe - AC-3', async () => {
    // One 500, or one ten-second timeout, is not an outage. Alerting on it teaches the operator
    // that this channel cries wolf, and the next real one is ignored.
    post.mockRejectedValue({ isAxiosError: true, response: { status: 500, data: 'boom' } });
    await tick();
    expect(send).not.toHaveBeenCalled();
  });

  it('a failure CONTRADICTED by the next probe never alerts', async () => {
    post.mockRejectedValue({ isAxiosError: true, response: { status: 500, data: 'boom' } });
    await tick();
    post.mockResolvedValue(routeOk);
    await runTravelHealthCheck({ confirming: true });
    expect(send).not.toHaveBeenCalled();

    // And the pending mark is gone, so the NEXT single failure also gets its confirmation
    // rather than being treated as the second of a pair.
    post.mockRejectedValue({ isAxiosError: true, response: { status: 500, data: 'boom' } });
    await tick();
    expect(send).not.toHaveBeenCalled();
  });

  it('only ONE instance probes per window - the others are told nothing was asked', async () => {
    // Without the lease the billed cost multiplies by instance count, and "two consecutive
    // failures" stops meaning anything: two hosts observing one instant would look like one host
    // observing twice.
    post.mockResolvedValue(routeOk);
    await tick();
    const second = await runTravelHealthCheck();
    expect(second.state).toBe('skipped');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('alerts when routing is down, and says bookings are still being taken', async () => {
    await confirmedOutage();

    expect(send).toHaveBeenCalledTimes(1);
    const body = String(mail().body);
    // AC-4: the alert says what is happening and what to do, not that a counter moved.
    expect(body).toMatch(/still being taken/i);
    expect(body).toMatch(/distance/i);
    // Google was actually asked. Without this the test passes on the no-key branch too, which is
    // how it passed before the mock above made the key real - the three failure states share a
    // body and differ only in the cause line.
    expect(post).toHaveBeenCalledTimes(2);
    expect(body).toMatch(/unreachable or answered unusably/i);
  });

  it('asks Google the way production does - TRAFFIC_AWARE, or it watches a path nobody takes', () => {
    // A cheaper traffic-unaware probe bills a different SKU and would stay green through exactly
    // the Pro quota and billing failures that break every real booking.
    post.mockResolvedValue(routeOk);
    return runTravelHealthCheck().then(() => {
      expect(post.mock.calls[0]?.[1]).toMatchObject({ routingPreference: 'TRAFFIC_AWARE' });
    });
  });

  it('separates a REFUSAL from an outage, because the responses differ', async () => {
    await confirmedOutage(403);
    expect(String(mail().body)).toMatch(/billing account|key restrictions/i);
  });

  it('answers a missing key without calling Google at all, and alerts at once', async () => {
    // A missing key is DETERMINISTIC, not transient - a second look cannot change it - so the
    // confirmation rule does not apply and waiting would only delay something already certain.
    delete process.env.GOOGLE_MAPS_API_KEY;
    const health = await runTravelHealthCheck();
    expect(health.state).toBe('no_key');
    expect(post).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(mail().body)).toMatch(/no GOOGLE_MAPS_API_KEY is configured/i);
  });

  it('alerts ONCE while the outage stands, not every tick', async () => {
    await confirmedOutage();
    await runTravelHealthCheck({ confirming: true });
    await runTravelHealthCheck({ confirming: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('announces recovery on a SUCCESSFUL probe, then re-arms', async () => {
    await confirmedOutage();
    post.mockResolvedValue(routeOk);
    await runTravelHealthCheck({ confirming: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(String(mail(1).subject)).toMatch(/recovered/i);

    // Re-armed: a second CONFIRMED outage alerts again rather than being swallowed by the old
    // latch.
    await confirmedOutage();
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
    await tick();
    send.mockRejectedValueOnce(new Error('SMTP refused'));

    await expect(runTravelHealthCheck({ confirming: true })).resolves.toMatchObject({ state: 'unreachable' });
    expect(logger.error).toHaveBeenCalledWith(
      '[travel-health] ALERT DELIVERY FAILED',
      expect.objectContaining({ error: 'SMTP refused' })
    );
  });

  it('a RETURNED delivery failure is not mistaken for a delivery, and the alert is retried', async () => {
    // The likely failure, and the one that reads as success. `send` reports an unconfigured key
    // or a provider error by RETURNING `{success:false}`. The latch is claimed before the mail
    // goes, so believing this succeeded would mark the outage announced, retry nothing, and
    // rebuild the exact silence this ticket exists to end.
    post.mockRejectedValue({ isAxiosError: true, response: { status: 500, data: 'boom' } });
    await tick();
    send.mockResolvedValueOnce({ success: false, error: 'not configured' });

    await runTravelHealthCheck({ confirming: true });
    expect(logger.error).toHaveBeenCalledWith(
      '[travel-health] ALERT DELIVERY FAILED',
      expect.objectContaining({ error: 'not configured' })
    );
    // Re-armed rather than latched: the next check tries to tell somebody again.
    expect(store.has('travel:health:incident:probe')).toBe(false);

    await runTravelHealthCheck({ confirming: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a failed RECOVERY notice does not re-raise an outage that ended', async () => {
    // The other direction, and it must not be symmetrical. Re-claiming here would report a
    // failure that is over - a false alarm, which costs more trust than a missed all-clear.
    await confirmedOutage();
    post.mockResolvedValue(PROBE_OK);
    send.mockResolvedValueOnce({ success: false, error: 'not configured' });

    await runTravelHealthCheck({ confirming: true });
    expect(store.has('travel:health:incident:probe')).toBe(false);
    // Still quiet on the next healthy tick - there is no incident left to recover from.
    send.mockClear();
    await tick();
    expect(send).not.toHaveBeenCalled();
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

  it('does NOT clear on a quiet window - silence is what no traffic looks like', async () => {
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

  it('a PARTIAL failure still raises - some requests answering does not make it fine', async () => {
    // The clause that used to sit here required zero successes to raise, so a partial or
    // regional failure could never raise at all. That is precisely the case observation exists
    // for, since the probe's one fixed journey cannot see it either. A drive that was not
    // measured was not checked, whoever else got an answer.
    await recordRoutingSuccess();
    await observePlatformFailures(PLATFORM_THRESHOLD);

    await reconcileObservedDegradation();
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(mail().subject)).toMatch(/failing on real bookings/i);
  });

  it('orders a success against a failure, rather than counting them', async () => {
    // A success at the START of a window says nothing about twenty failures after it, which is
    // why the recovery test is "did anything answer SINCE the last failure" and not "were there
    // any successes". Ordering comes from Redis, so it holds across instances without trusting
    // any host's clock.
    await observePlatformFailures(PLATFORM_THRESHOLD);
    await reconcileObservedDegradation();
    send.mockClear();

    // Another failure after the success: still failing, no all-clear.
    await recordRoutingSuccess();
    await recordCause('api_error');
    await reconcileObservedDegradation();
    expect(send).not.toHaveBeenCalled();

    // Now the latest event answered.
    await recordRoutingSuccess();
    await reconcileObservedDegradation();
    expect(String(mail().subject)).toMatch(/recovered/i);
  });
});

describe('a monitor that cannot see must say so', () => {
  it('alerts that MONITORING is degraded when Redis is gone, and does not report health', async () => {
    // The one failure that makes every other guarantee in the file untrue without saying so:
    // every counter and latch lives in Redis, so without it the monitor reads zero failures, no
    // standing incident, and reports perfect health precisely because it has gone blind.
    redisDown = true;
    await runTravelHealthCheck();

    expect(send).toHaveBeenCalled();
    const subjects = send.mock.calls.map((c) => String(c[0].subject));
    expect(subjects.some((s) => /monitoring is degraded/i.test(s))).toBe(true);
    expect(String(mail().body)).toMatch(/reported late, repeatedly, or not at all/i);
  });

  it('says it ONCE per outage, not every tick', async () => {
    redisDown = true;
    await runTravelHealthCheck();
    const first = send.mock.calls.filter((c) => /monitoring is degraded/i.test(String(c[0].subject))).length;
    await runTravelHealthCheck();
    const second = send.mock.calls.filter((c) => /monitoring is degraded/i.test(String(c[0].subject))).length;
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it('reports `unknown` rather than zeros, so quiet is not mistaken for healthy', async () => {
    redisDown = true;
    const snapshot = await travelHealthSnapshot();
    expect(snapshot.monitoring).toBe('unknown');
  });

  it('re-arms only on a POSITIVE reading, so a recovered Redis is proved not assumed', async () => {
    redisDown = true;
    await runTravelHealthCheck();
    redisDown = false;
    await tickTop();
    send.mockClear();

    redisDown = true;
    await runTravelHealthCheck();
    expect(send.mock.calls.some((c) => /monitoring is degraded/i.test(String(c[0].subject)))).toBe(true);
  });
});

describe('the operator half of a tenant-scoped cause', () => {
  it('counts DISTINCT tenants, so one busy tenant cannot look like an epidemic', async () => {
    // Raw occurrences cannot answer "is this platform-wide". One tenant at its cap emits an event
    // per booking; twenty tenants hitting theirs once each - the pattern actually worth seeing -
    // would look like nothing beside it.
    for (let i = 0; i < 50; i += 1) await recordCause('cap_exhausted', { tenantId: 'tenant-a' });
    expect((await scopedCauseSpread()).capExhaustedTenants).toBe(1);

    await recordCause('cap_exhausted', { tenantId: 'tenant-b' });
    expect((await scopedCauseSpread()).capExhaustedTenants).toBe(2);
  });

  it('counts a shared itinerary per AGENT, not per tenant', async () => {
    await recordCause('shared_itinerary', { tenantId: 't1', botId: 'bot-1' });
    await recordCause('shared_itinerary', { tenantId: 't1', botId: 'bot-2' });
    await recordCause('shared_itinerary', { tenantId: 't1', botId: 'bot-1' });
    expect((await scopedCauseSpread()).sharedItineraryBots).toBe(2);
  });

  it('never mails either of them - the tenant was already told by their own notifier', async () => {
    await recordCause('cap_exhausted', { tenantId: 'tenant-a' });
    await recordCause('shared_itinerary', { tenantId: 't1', botId: 'bot-1' });
    expect(send).not.toHaveBeenCalled();
  });
});
