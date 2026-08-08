/**
 * Is routing working right now?
 *
 * A SYNTHETIC PROBE, and the reason is the whole of this ticket. The obvious design — watch the
 * causes real bookings emit — cannot answer this question, because with no tenant entitled the
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
 * coordinate pair does not reach. Either may raise the alert — but a probe success must NOT
 * clear an incident that real traffic raised, or a regional failure would produce an all-clear
 * that had not happened and oscillate for as long as it lasted. So each source clears only what
 * it raised, and each needs POSITIVE evidence to do it.
 */
import axios from 'axios';
import { config } from '../../config/environment';
import { getRedisClient, isRedisAvailable } from '../../config/redis';
import { getEmailService } from '../../automations';
import { logger } from '../../utils/logger';
import { PLATFORM_THRESHOLD, metricCounts, platformFailures, routingSuccesses } from './degradation-monitor';

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
  /** No key configured. Answered without a call — there is nothing to ask. */
  | { state: 'no_key' }
  /** Google answered, and the answer was a refusal: quota, billing, a rejected key. */
  | { state: 'refused'; detail: string }
  /** Unreachable, malformed, or anything else. */
  | { state: 'unreachable'; detail: string };

/** Read per alert, not at module load, so changing the variable does not need a restart. */
const alertInbox = (): string =>
  process.env.PLATFORM_ALERT_EMAIL?.trim() || process.env.SUPPORT_EMAIL?.trim() || 'support@axentrio.com';

/** One real, minimal Route Matrix call against the PLATFORM key. Never throws. */
export async function probeTravelHealth(): Promise<TravelHealth> {
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
    // attention, a suppressed one costs the outage this exists to surface.
    logger.warn('[travel-health] no Redis — alerting without deduplication');
    return true;
  }
  const claimed = await redis.set(incidentKey(source), detail, 'NX');
  return claimed === 'OK';
}

/** Clear a standing incident, answering whether one was actually standing. */
async function releaseIncident(source: IncidentSource): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return false;
  return (await redis.del(incidentKey(source))) > 0;
}

async function alert(subject: string, body: string): Promise<void> {
  try {
    await getEmailService().send({ to: alertInbox(), subject, body });
  } catch (err) {
    // An alert that cannot be delivered must still be findable.
    logger.error('[travel-health] ALERT DELIVERY FAILED', {
      subject,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let loggedFirstResult = false;

/** The last probe result, so the admin snapshot can be read without spending an element. */
let lastProbe: { state: TravelHealth['state']; detail?: string; at: string } | null = null;

/** Reset between tests. */
export function __resetTravelHealthState(): void {
  loggedFirstResult = false;
  lastProbe = null;
}

/**
 * What an operator can see WITHOUT waiting for an alert.
 *
 * Everything here is already-recorded state: the cached probe result, the counters, and whether
 * an incident is standing. Opening the page must never itself probe — that would put a Google
 * call behind a page load and make the cost of looking unbounded.
 */
export async function travelHealthSnapshot(): Promise<{
  lastProbe: { state: string; detail?: string; at: string } | null;
  incidents: { probe: boolean; observed: boolean };
  observedPlatformFailures: number;
  /** Counted, never mailed. A sustained rate here is the signal (§5c). */
  rates: Record<string, number>;
}> {
  const redis = getRedisClient();
  const standing = async (source: IncidentSource): Promise<boolean> => {
    if (!redis || !isRedisAvailable()) return false;
    try {
      return (await redis.get(incidentKey(source))) !== null;
    } catch {
      return false;
    }
  };
  const [probe, observed, failures, rates] = await Promise.all([
    standing('probe'),
    standing('observed'),
    platformFailures(),
    metricCounts(),
  ]);
  return { lastProbe, incidents: { probe, observed }, observedPlatformFailures: failures, rates };
}

/**
 * Probe once, and alert on the transition.
 *
 * Returns the health so the admin observability endpoint can show it without probing again.
 */
export async function runTravelHealthCheck(): Promise<TravelHealth> {
  const health = await probeTravelHealth();
  lastProbe = {
    state: health.state,
    ...(health.state === 'refused' || health.state === 'unreachable' ? { detail: health.detail } : {}),
    at: new Date().toISOString(),
  };

  if (!loggedFirstResult) {
    loggedFirstResult = true;
    // A healthy probe is silent, and so is one that never started. Log the first result
    // whatever it is, so "the watchdog is alive" is verifiable without an outage to prove it.
    logger.info('[travel-health] probe active', { state: health.state, inbox: alertInbox() });
  }

  if (health.state === 'ok') {
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
  if (!(await claimIncident('probe', detail))) return health;

  logger.error('[travel-health] ROUTING IS DOWN — travel checks are falling back to distance bounds', {
    state: health.state,
    detail,
  });
  await alert(
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
          ? 'Cause: Google REFUSED the request — check the billing account and the API key restrictions.'
          : 'Cause: Google was unreachable or answered unusably.',
      '',
      `Google said: ${detail}`,
    ].join('\n')
  );
  return health;
}

/**
 * The other latch: platform failures seen in REAL traffic.
 *
 * The probe cannot see a failure its single coordinate pair does not reach, and real bookings
 * can. This raises on corroboration — one flaky request is not an outage — and clears only on a
 * SUCCESSFUL ROUTED REQUEST, never on a quiet window, because silence is what no booking traffic
 * looks like rather than what recovery looks like.
 */
export async function reconcileObservedDegradation(): Promise<void> {
  const [failures, successes] = await Promise.all([platformFailures(), routingSuccesses()]);

  if (failures >= PLATFORM_THRESHOLD && successes === 0) {
    if (!(await claimIncident('observed', `${failures} platform failures observed`))) return;
    logger.error('[travel-health] sustained platform degradation in real bookings', { failures });
    await alert(
      'Axentrio: travel-time routing failing on real bookings',
      [
        `${failures} routing requests failed with a platform-level cause and none succeeded.`,
        '',
        'The synthetic probe may still be healthy — it checks one fixed journey — so this is a',
        'failure real customer bookings are hitting that the probe does not reach.',
        '',
        'Check the Google billing account, the key restrictions, and the Routes API quota.',
      ].join('\n')
    );
    return;
  }

  // Recovery needs something affirmative. A window that simply went quiet proves nothing.
  if (successes > 0 && (await releaseIncident('observed'))) {
    logger.info('[travel-health] real bookings are routing again', { successes });
    await alert(
      'Axentrio: travel-time routing recovered on real bookings',
      `Routing requests are succeeding again (${successes} in the current window).`
    );
  }
}

/**
 * Agents that are ALREADY sharing a diary when this ships.
 *
 * `warnIfTravelItineraryNowShared` only fires on a rekey, so an Agent that was already sharing a
 * calendar has had travel silently inert for as long as that has been true and will never
 * trigger one. Without this pass the configuration alert only ever catches the case that arrives
 * AFTER the monitor — which is the smaller half, and not the half anybody is living with.
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
