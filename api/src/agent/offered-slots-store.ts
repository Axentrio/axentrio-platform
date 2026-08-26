// Remembers what check_availability offered, to judge a booking time the model sent.
//
// The booking tools demand a ZONELESS local time, but the prompt also says "prefer the exact
// slot start returned by check_availability, verbatim" — and those slot starts are UTC
// instants with a Z. Three live failures in one afternoon (2026-08-26), one per naive rule:
//   - echo the customer's "om 10:00" as 10:00Z → booked 12:00 Brussels;
//   - blanket-strip the offered 09:00Z slot → booked 09:00 instead of the 11:00 it named;
//   - echo "om 13:00" as 13:00Z, which happened to BE an offered instant (15:00 local) →
//     the offered-slot check kept it and booked 15:00.
// The disambiguator is the CUSTOMER'S OWN CLOCK TIME: an offset-bearing instant may only
// stand when its business-local clock matches what the customer actually named (or when the
// customer named no time at all and the instant is a verbatim offered slot).

import { logger } from '../utils/logger';
import { DateTime } from 'luxon';
import { parseClockTimes } from './clock-times';
import { getRedisClient } from '../config/redis';

interface OfferedSlots {
  starts: string[];
  timezone: string;
}

const key = (sessionId: string): string => `booking:offered:${sessionId}`;
const TTL_MS = 24 * 60 * 60 * 1000;

export async function rememberOfferedSlots(
  sessionId: string,
  starts: string[],
  timezone: string,
): Promise<void> {
  if (!starts.length) return;
  const redis = getRedisClient();
  if (!redis) return; // fail open: without memory the booking tools strip offsets
  try {
    const payload: OfferedSlots = { starts, timezone };
    await redis.set(key(sessionId), JSON.stringify(payload), 'PX', String(TTL_MS));
  } catch {
    // fail open
  }
}

async function getOfferedSlots(sessionId: string): Promise<OfferedSlots | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(key(sessionId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as OfferedSlots).starts) &&
      typeof (parsed as OfferedSlots).timezone === 'string'
    ) {
      return parsed as OfferedSlots;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a booking time the model sent.
 *
 * Zoneless passes through untouched — that is the contract. Offset-bearing passes through ONLY
 * when the instant is one of the offered slots AND its business-local clock matches the time
 * the customer named (or the customer named no clock time). Everything else is read as the
 * wall clock the customer said.
 */
export async function resolveBookingTime(
  sessionId: string,
  value: string,
  customerText: string,
): Promise<string> {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return value;

  const instant = Date.parse(value);
  const namedClocks = new Set(
    parseClockTimes(customerText).map((t) => t.key),
  );

  if (Number.isFinite(instant)) {
    const offered = await getOfferedSlots(sessionId);
    if (offered) {
      const isOfferedInstant = offered.starts.some((s) => {
        const offeredAt = Date.parse(s);
        return Number.isFinite(offeredAt) && Math.abs(offeredAt - instant) < 1000;
      });
      const localClock = DateTime.fromMillis(instant).setZone(offered.timezone).toFormat('HH:mm');
      // A verbatim slot stands unless it contradicts the hour the customer named. When the
      // customer named nothing ("book the first one"), the slot is the only signal.
      if (isOfferedInstant && (namedClocks.size === 0 || namedClocks.has(localClock))) {
        return value;
      }
    }
  }

  const stripped = value.replace(/(?:Z|[+-]\d{2}:?\d{2})$/i, '');
  logger.warn('[booking] offset-bearing time contradicts the customer; re-read as business wall clock', {
    sessionId,
    received: value,
    interpreted: stripped,
    customerNamed: [...namedClocks],
  });
  return stripped;
}
