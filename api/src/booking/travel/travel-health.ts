/**
 * Is routing working right now?
 *
 * A SYNTHETIC PROBE, and the reason is the whole of this ticket. The obvious design - watch the
 * causes real bookings emit - cannot answer this question, because with no tenant entitled the
 * monitor receives zero events whether Google is healthy or completely broken. Quiet periods do
 * the same thing on a live platform. An alarm for a silent failure that is itself silent when
 * nothing is running is not an alarm.
 *
 * TRAFFIC-AWARE, matching production. Real lookups inside 24 hours are traffic-aware and bill
 * against the Pro SKU; a traffic-unaware probe would be cheaper and blind to exactly the
 * Pro-specific quota, billing and request-shape failures that would break every booking. A
 * watchdog that does not exercise the production contract watches a path nobody takes.
 * ~1,440 elements a month at a 30-minute cadence, inside the 5k Pro free tier with room left for
 * real traffic.
 *
 * TWO INDEPENDENT INCIDENT LATCHES, and this is the part that took the longest to get right.
 * The probe covers the no-traffic case; observed platform causes cover a failure this one
 * coordinate pair does not reach. Either may raise the alert - but a probe success must NOT
 * clear an incident that real traffic raised, or a regional failure would produce an all-clear
 * that had not happened and oscillate for as long as it lasted. So each source clears only what
 * it raised, and each needs POSITIVE evidence to do it.
 */
import axios from 'axios';
import { config } from '../../config/environment';
import { getRedisClient, isRedisAvailable } from '../../config/redis';
import { getEmailService } from '../../automations';
import { logger } from '../../utils/logger';
import {
  PLATFORM_THRESHOLD,
  metricCounts,
  monitorState,
  platformFailures,
  routingRecoveredSinceLastFailure,
  scopedCauseSpread,
} from './degradation-monitor';

/**
 * Two points in Belgium, far enough apart to need a real route.
 *
 * Fixed on purpose: the probe answers "does routing work", not "is this journey possible", and a
 * varying pair would make a failure impossible to distinguish from a bad geocode.
 */
const PROBE_FROM = { latitude: 51.0543, longitude: 3.7174 }; // Gent
const PROBE_TO = { latitude: 51.2194, longitude: 4.4025 }; // Antwerpen

export type TravelHealth =
  /** A route came back. */
  | { state: 'ok' }
  /** Another instance holds this window's probe lease. NOT a health claim - nothing was asked. */
  | { state: 'skipped' }
  /** No key configured. Answered without a call - there is nothing to ask. */
  | { state: 'no_key' }
  /** Google answered, and the answer was a refusal: quota, billing, a rejected key. */
  | { state: 'refused'; detail: string }
  /** Unreachable, malformed, or anything else. */
  | { state: 'unreachable'; detail: string };

/** Read per alert, not at module load, so changing the variable does not need a restart. */
const alertInbox = (): string =>
  process.env.PLATFORM_ALERT_EMAIL?.trim() || process.env.SUPPORT_EMAIL?.trim() || 'support@axentrio.com';

/**
 * What one probe can answer. `skipped` is not among them: it describes a probe that never
 * happened, which is a scheduling outcome rather than a reading.
 */
export type ProbeResult = Exclude<TravelHealth, { state: 'skipped' }>;

/** One real, minimal Route Matrix call against the PLATFORM key. Never throws. */
export async function probeTravelHealth(): Promise<ProbeResult> {
  const apiKey = config.travel.googleMapsApiKey;
  if (!apiKey) return { state: 'no_key' };

  try {
    const res = await axios.post(
      'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
      {
        origins: [{ waypoint: { location: { latLng: PROBE_FROM } } }],
        destinations: [{ waypoint: { location: { latLng: PROBE_TO } } }],
        travelMode: 'DRIVE',
        // The production contract, not a cheaper approximation of it.
        routingPreference: 'TRAFFIC_AWARE',
        departureTime: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
      {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,condition',
        },
      }
    );
    const rows = Array.isArray(res.data) ? res.data : [];
    const answered = rows.some((r: { condition?: string }) => r?.condition === 'ROUTE_EXISTS');
    return answered ? { state: 'ok' } : { state: 'unreachable', detail: 'no ROUTE_EXISTS in the answer' };
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const detail = axios.isAxiosError(err)
      ? `${status ?? 'network'}: ${JSON.stringify(err.response?.data ?? err.message).slice(0, 300)}`
      : err instanceof Error
        ? err.message
        : String(err);
    // A refusal and an outage need different responses: one is somebody paying or fixing a key,
    // the other is waiting or escalating. 401/403 is a rejected key; 429 is quota.
    if (status === 401 || status === 403 || status === 429) return { state: 'refused', detail };
    return { state: 'unreachable', detail };
  }
}

/** Which source raised a standing incident. Each clears only what it raised. */
type IncidentSource = 'probe' | 'observed';

const incidentKey = (source: IncidentSource) => `travel:health:incident:${source}`;

/**
 * Claim the transition, so only ONE instance alerts.
 *
 * `SET NX` is the claim: the first instance to write the marker sends the mail and the rest see
 * it already exists. Held in Redis rather than per process because several instances run, and a
 * per-process latch would mail once each.
 */
async function claimIncident(source: IncidentSource, detail: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) {
    // No claim is possible, so alerting anyway is the safer failure: a duplicate mail costs
    // attention, a suppressed one costs the outage this exists to surface. The fact that
    // deduplication is NOT happening is itself reported - see `reportMonitorBlind`.
    logger.warn('[travel-health] no Redis - alerting without deduplication');
    return true;
  }
  const claimed = await redis.set(incidentKey(source), detail, 'NX');
  return claimed === 'OK';
}

/**
 * Only one instance should probe per tick.
 *
 * Two things break without this. The billed cost multiplies by instance count, so the ~1,440
 * elements a month this is budgeted at is really 1,440 times however many containers are running.
 * And "two consecutive failures" stops meaning anything: with three instances probing on their
 * own timers, two failures can be two hosts observing the same instant rather than the same host
 * observing twice.
 *
 * A short-lived lease rather than a lock: an instance that dies mid-probe must not hold the
 * cadence hostage, and the worst case of an expired lease is one extra probe.
 */
const PROBE_LEASE_KEY = 'travel:health:probe-lease';
const PROBE_LEASE_SECONDS = 20 * 60;

async function claimProbeLease(): Promise<boolean> {
  const redis = getRedisClient();
  // With no Redis there is no coordination to be had. Probing is the safer failure: skipping
  // would leave the watchdog silent, which is the state this ticket exists to end.
  if (!redis || !isRedisAvailable()) return true;
  try {
    return (await redis.set(PROBE_LEASE_KEY, '1', 'EX', PROBE_LEASE_SECONDS, 'NX')) === 'OK';
  } catch {
    return true;
  }
}

/**
 * A failure seen once, waiting to be confirmed or contradicted.
 *
 * AC-3 is explicit that a single transient failure must not alert, and one 500 or one ten-second
 * timeout is exactly that. But waiting for the next 30-minute tick would delay a REAL outage by
 * up to an hour, so the first failure schedules a confirmation instead: the pending state is
 * recorded, a second probe follows shortly, and only a second failure alerts.
 *
 * Held in Redis, not in the process, so the instance that sees the first failure and the one that
 * confirms it agree about what happened.
 */
const PENDING_KEY = 'travel:health:pending-failure';
const PENDING_TTL_SECONDS = 15 * 60;

/** How long to wait before the confirming probe. Long enough to outlast a blip, short enough that
 *  a real outage is announced in minutes rather than at the next half-hourly tick. */
export const CONFIRMATION_DELAY_MS = 90_000;

async function markPendingFailure(detail: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return;
  try {
    await redis.set(PENDING_KEY, detail, 'EX', PENDING_TTL_SECONDS);
  } catch {
    /* best effort: the confirmation path degrades to alerting on the next tick */
  }
}

async function takePendingFailure(): Promise<boolean> {
  const redis = getRedisClient();
  // Without Redis there is no memory of a previous failure, so a single one can never be
  // confirmed. Treating it as confirmed would alert on a transient, which AC-3 forbids.
  if (!redis || !isRedisAvailable()) return false;
  try {
    return (await redis.get(PENDING_KEY)) !== null;
  } catch {
    return false;
  }
}

async function clearPendingFailure(): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return;
  try {
    await redis.del(PENDING_KEY);
  } catch {
    /* best effort */
  }
}

/** Clear a standing incident, answering whether one was actually standing. */
async function releaseIncident(source: IncidentSource): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return false;
  return (await redis.del(incidentKey(source))) > 0;
}

/**
 * Send one alert, and answer whether it actually went.
 *
 * THE RETURN VALUE IS LOAD-BEARING, and the reason is a trap in the mail seam: `EmailService.send`
 * does NOT throw when delivery fails - an unconfigured Resend key or a provider error comes back
 * as `{ success: false }`. A `try`/`catch` alone therefore treats the most likely failure as a
 * success, and since the incident latch is claimed BEFORE this runs, the outage would be recorded
 * as announced and never retried. That is this ticket's own defect rebuilt inside its fix.
 */
async function alert(subject: string, body: string): Promise<boolean> {
  try {
    const result = await getEmailService().send({ to: alertInbox(), subject, body });
    if (result?.success === false) {
      // An alert that cannot be delivered must still be findable.
      logger.error('[travel-health] ALERT DELIVERY FAILED', { subject, error: result.error });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('[travel-health] ALERT DELIVERY FAILED', {
      subject,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Give the claim back when the alert did not go, so the next tick tries again.
 *
 * Only ever on the RAISE path. A failed RECOVERY notice must not re-raise the incident - that
 * would report an outage that had ended, which is the false-alarm direction, and the log line
 * above is the right record of it.
 */
async function releaseUndeliveredClaim(source: IncidentSource, delivered: boolean): Promise<void> {
  if (delivered) return;
  await releaseIncident(source);
  logger.warn('[travel-health] alert undelivered - re-arming so the next check retries', { source });
}

let loggedFirstResult = false;

type ProbeRecord = { state: TravelHealth['state']; detail?: string; at: string };

/**
 * The last probe result, so the admin snapshot can be read without spending an element.
 *
 * Kept in Redis as well as in the process, because only one instance probes per window now: an
 * operator who opens the page on any other instance would otherwise be told `null` forever. The
 * process copy is the fallback for when Redis is the thing that is down.
 */
let lastProbe: ProbeRecord | null = null;
const LAST_PROBE_KEY = 'travel:health:last-probe';

async function publishProbe(record: ProbeRecord): Promise<void> {
  lastProbe = record;
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return;
  try {
    await redis.set(LAST_PROBE_KEY, JSON.stringify(record));
  } catch {
    /* the in-process copy still answers for this instance */
  }
}

async function readLastProbe(): Promise<ProbeRecord | null> {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return lastProbe;
  try {
    const raw = await redis.get(LAST_PROBE_KEY);
    return raw ? (JSON.parse(raw) as ProbeRecord) : lastProbe;
  } catch {
    return lastProbe;
  }
}

/** Reset between tests. */
export function __resetTravelHealthState(): void {
  loggedFirstResult = false;
  lastProbe = null;
  reportedBlind = false;
}

/**
 * What an operator can see WITHOUT waiting for an alert.
 *
 * Everything here is already-recorded state: the cached probe result, the counters, and whether
 * an incident is standing. Opening the page must never itself probe - that would put a Google
 * call behind a page load and make the cost of looking unbounded.
 */
export async function travelHealthSnapshot(): Promise<{
  /**
   * `unknown` when Redis is down. Every number below is read from it, so reporting zeros in that
   * state would tell an operator the monitor is quiet when in fact it is blind.
   */
  monitoring: 'ok' | 'unknown';
  lastProbe: ProbeRecord | null;
  incidents: { probe: boolean; observed: boolean };
  observedPlatformFailures: number;
  /** Counted, never mailed. A sustained rate here is the signal (§5c). */
  rates: Record<string, number>;
  /** DISTINCT affected parties, which is the only count that shows a platform-wide pattern. */
  spread: { capExhaustedTenants: number; sharedItineraryBots: number };
}> {
  const monitoring = await monitorState();
  const probeRecord = await readLastProbe();
  if (monitoring !== 'ok') {
    return {
      monitoring,
      lastProbe: probeRecord,
      incidents: { probe: false, observed: false },
      observedPlatformFailures: 0,
      rates: {},
      spread: { capExhaustedTenants: 0, sharedItineraryBots: 0 },
    };
  }

  const redis = getRedisClient();
  const standing = async (source: IncidentSource): Promise<boolean> => {
    if (!redis || !isRedisAvailable()) return false;
    try {
      return (await redis.get(incidentKey(source))) !== null;
    } catch {
      return false;
    }
  };
  const [probe, observed, failures, rates, spread] = await Promise.all([
    standing('probe'),
    standing('observed'),
    platformFailures(),
    metricCounts(),
    scopedCauseSpread(),
  ]);
  return {
    monitoring,
    lastProbe: probeRecord,
    incidents: { probe, observed },
    observedPlatformFailures: failures,
    rates,
    spread,
  };
}

/**
 * Probe once, and alert on the transition.
 *
 * Returns the health for callers that want to act on it. The scheduler discards it and the admin
 * snapshot reads the cached `lastProbe` instead, so nothing in production depends on the value.
 */
export async function runTravelHealthCheck(options?: { confirming?: boolean }): Promise<TravelHealth> {
  // Before anything else: if the monitor is blind, say so. Every guarantee below depends on
  // Redis, and a blind monitor reports perfect health.
  await reportMonitorBlind();

  // The confirming probe is a continuation of the tick that already took the lease, not a new
  // one. Making it queue behind its own lease would mean the confirmation never happens.
  if (!options?.confirming && !(await claimProbeLease())) {
    // Another instance is probing this window. Saying `ok` here would be a claim of health with
    // nothing behind it, so this is its own answer.
    return { state: 'skipped' };
  }

  const health = await probeTravelHealth();
  await publishProbe({
    state: health.state,
    ...(health.state === 'refused' || health.state === 'unreachable' ? { detail: health.detail } : {}),
    at: new Date().toISOString(),
  });

  if (!loggedFirstResult) {
    loggedFirstResult = true;
    // A healthy probe is silent, and so is one that never started. Log the first result
    // whatever it is, so "the watchdog is alive" is verifiable without an outage to prove it.
    logger.info('[travel-health] probe active', { state: health.state, inbox: alertInbox() });
  }

  if (health.state === 'ok') {
    // A success contradicts a failure that was awaiting confirmation, so it was a blip.
    await clearPendingFailure();
    // POSITIVE EVIDENCE, and only for what the probe itself raised.
    if (await releaseIncident('probe')) {
      logger.info('[travel-health] routing recovered');
      await alert(
        'Axentrio: travel-time routing recovered',
        'Google Routes is answering again. Travel checking is back to verifying drives rather than falling back to distance bounds.'
      );
    }
    return health;
  }

  const detail = health.state === 'no_key' ? 'no GOOGLE_MAPS_API_KEY configured' : health.detail;

  // A MISSING KEY IS NOT TRANSIENT. It is a deterministic fact about this deployment that a
  // second look cannot change, so the confirmation rule below does not apply to it - waiting
  // would only delay saying something certain.
  if (health.state !== 'no_key' && !(await takePendingFailure())) {
    await markPendingFailure(detail);
    logger.warn('[travel-health] probe failed once - confirming before alerting', {
      state: health.state,
      detail,
    });
    // Confirm in a couple of minutes rather than on the next half-hourly tick. A real outage is
    // announced in minutes; a single flaky request never alerts at all.
    setTimeout(() => {
      void runTravelHealthCheck({ confirming: true }).catch((err) =>
        logger.error('[travel-health] confirmation probe failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }, CONFIRMATION_DELAY_MS).unref?.();
    return health;
  }

  if (!(await claimIncident('probe', detail))) return health;

  logger.error('[travel-health] ROUTING IS DOWN - travel checks are falling back to distance bounds', {
    state: health.state,
    detail,
  });
  const delivered = await alert(
    'Axentrio: travel-time routing is down',
    [
      'Google Routes is not answering, so travel-time checking has fallen back to straight-line',
      'distance bounds and the flat minimum gap.',
      '',
      'Bookings are still being taken. They are just less protected than the owner believes:',
      'a drive that distance alone cannot rule out will be offered.',
      '',
      health.state === 'no_key'
        ? 'Cause: no GOOGLE_MAPS_API_KEY is configured on this service.'
        : health.state === 'refused'
          ? 'Cause: Google REFUSED the request - check the billing account and the API key restrictions.'
          : 'Cause: Google was unreachable or answered unusably.',
      '',
      `Google said: ${detail}`,
    ].join('\n')
  );
  await releaseUndeliveredClaim('probe', delivered);
  // Cleared only when the alert actually went. Then the mark has done its job - the incident is
  // standing - and leaving it would make the NEXT outage skip its confirmation. If delivery
  // failed, the failure is still awaiting escalation, so the mark stays and the retry alerts on
  // the next probe rather than paying for a second confirmation cycle first.
  if (delivered) await clearPendingFailure();
  return health;
}

/**
 * The monitor cannot see, and that is itself worth an alert.
 *
 * Redis holds every counter, latch and lease here. Without it the observed path reads zero
 * failures, no incident stands, and nothing deduplicates - so the monitor reports perfect health
 * precisely because it has gone blind. That is this ticket's defect one layer up, and it is the
 * one failure that would make every other guarantee in this file untrue without saying so.
 *
 * LATCHED PER PROCESS, and it has to be: the shared latch lives in the thing that is down. One
 * mail per instance per Redis outage is the honest cost, and it is bounded by instance count
 * rather than by time.
 */
let reportedBlind = false;

async function reportMonitorBlind(): Promise<void> {
  if ((await monitorState()) === 'ok') {
    // Only a POSITIVE reading re-arms it, so a recovered Redis is proved rather than assumed.
    reportedBlind = false;
    return;
  }
  if (reportedBlind) return;
  reportedBlind = true;

  logger.error('[travel-health] MONITORING IS DEGRADED - Redis is unavailable');
  await alert(
    'Axentrio: travel-time monitoring is degraded',
    [
      'Redis is not available, so the travel-time monitor has lost the state it works from:',
      'the failure counters, the incident latches and the cross-instance deduplication.',
      '',
      'Travel checking itself is unaffected. What is affected is the ability to tell you when it',
      'breaks - while this lasts, an outage may be reported late, repeatedly, or not at all.',
      '',
      'Check the Redis service before trusting a quiet travel-time alert channel.',
    ].join('\n')
  );
}

/**
 * The other latch: platform failures seen in REAL traffic.
 *
 * The probe cannot see a failure its single coordinate pair does not reach, and real bookings
 * can. This raises on corroboration - one flaky request is not an outage - and clears only on a
 * SUCCESSFUL ROUTED REQUEST, never on a quiet window, because silence is what no booking traffic
 * looks like rather than what recovery looks like.
 */
export async function reconcileObservedDegradation(): Promise<void> {
  // A blind monitor reads zero failures and would report health it cannot see.
  if ((await monitorState()) !== 'ok') {
    await reportMonitorBlind();
    return;
  }

  // RECOVERY IS ASKED FIRST, and the order is the whole of it. The sequence comparison is
  // strictly more recent information than a count over a 30-minute window: if the latest routed
  // request answered, the failures behind it are history. Asking the count first would make
  // recovery unreachable until the window expired, because the raise branch would keep matching.
  if (await routingRecoveredSinceLastFailure()) {
    if (await releaseIncident('observed')) {
      logger.info('[travel-health] real bookings are routing again');
      await alert(
        'Axentrio: travel-time routing recovered on real bookings',
        'Routing requests are succeeding again - the most recent routed request answered, after the last failure.'
      );
    }
    return;
  }

  const failures = await platformFailures();

  // NO "and nothing succeeded" CLAUSE. An earlier draft required zero successes to raise, which
  // meant a PARTIAL failure - some requests answering, some not - could never raise at all. That
  // is exactly the case observation exists to catch, since the probe's single coordinate pair
  // cannot see it either. What disqualifies a raise is a success AFTER the last failure, which
  // is the branch above, not a success anywhere in the window.
  if (failures >= PLATFORM_THRESHOLD) {
    if (!(await claimIncident('observed', `${failures} platform failures observed`))) return;
    logger.error('[travel-health] sustained platform degradation in real bookings', { failures });
    const delivered = await alert(
      'Axentrio: travel-time routing failing on real bookings',
      [
        `${failures} routing requests failed with a platform-level cause in the last 30 minutes.`,
        '',
        'The synthetic probe may still be healthy - it checks one fixed journey - so this is a',
        'failure real customer bookings are hitting that the probe does not reach. Some requests',
        'may still be succeeding: a partial or regional failure counts, because a drive that is',
        'not measured is not checked, whoever else got an answer.',
        '',
        'Check the Google billing account, the key restrictions, and the Routes API quota.',
      ].join('\n')
    );
    await releaseUndeliveredClaim('observed', delivered);
  }
  // No `else`: a quiet window is not recovery. Silence is what NO BOOKING TRAFFIC looks like, and
  // an all-clear sent on it would be an announcement of something that never happened.
}

/**
 * Agents that are ALREADY sharing a diary when this ships.
 *
 * `warnIfTravelItineraryNowShared` only fires on a rekey, so an Agent that was already sharing a
 * calendar has had travel silently inert for as long as that has been true and will never
 * trigger one. Without this pass the configuration alert only ever catches the case that arrives
 * AFTER the monitor - which is the smaller half, and not the half anybody is living with.
 *
 * Cheap by shape: only Agents with the switch actually on are considered, which is none today.
 */
export async function reconcileSharedItineraries(): Promise<number> {
  const { AppDataSource } = await import('../../database/data-source');
  const { BookingSettings } = await import('../../database/entities/BookingSettings');
  const { Bot } = await import('../../database/entities/Bot');
  const { resolveItineraryKey, itineraryKeyIsShared } = await import('../../scheduler/itinerary-key');
  const { notifyItinerarySharedInert } = await import('./degradation-notify');

  const enabled = await AppDataSource.getRepository(BookingSettings).find({
    where: { travelTimeEnabled: true },
  });
  let found = 0;
  for (const settings of enabled) {
    try {
      const key = await resolveItineraryKey(settings.botId);
      if (!(await itineraryKeyIsShared(settings.tenantId, settings.botId, key))) continue;
      found += 1;
      const bot = await AppDataSource.getRepository(Bot).findOne({ where: { id: settings.botId } });
      // Deduplicated per Agent inside the notifier, so a standing misconfiguration is reported
      // once rather than daily.
      await notifyItinerarySharedInert({
        tenantId: settings.tenantId,
        botId: settings.botId,
        botName: bot?.name,
      });
    } catch (error) {
      // One bad Agent must not stop the sweep reaching the others.
      logger.warn('[travel-health] shared-itinerary reconciliation failed for an Agent', {
        botId: settings.botId,
        error,
      });
    }
  }
  if (found) logger.warn('[travel-health] Agents with travel enabled on a shared diary', { found });
  return found;
}
