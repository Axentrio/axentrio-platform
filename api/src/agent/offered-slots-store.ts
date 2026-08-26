// Remembers the exact slot ISO strings check_availability returned for a session.
//
// Why: the booking tools demand a ZONELESS local time, but the prompt also says
// "prefer the exact slot start returned by check_availability, verbatim" — and those slot
// starts are UTC instants with a Z. Two live failures, one per reading (2026-08-26):
//   - the model echoed the customer's "om 10:00" as 10:00Z → booked 12:00 Brussels;
//   - the model copied the offered 09:00Z slot verbatim → a blanket strip booked 09:00
//     instead of the 11:00 the customer named.
// The remembered list is the disambiguator: an offset-bearing time that IS one of the
// offered instants is kept verbatim; anything else is read as the customer's wall clock.

import { logger } from '../utils/logger';
import { getRedisClient } from '../config/redis';

const key = (sessionId: string): string => `booking:offered:${sessionId}`;
const TTL_MS = 24 * 60 * 60 * 1000;

export async function rememberOfferedSlots(sessionId: string, starts: string[]): Promise<void> {
  if (!starts.length) return;
  const redis = getRedisClient();
  if (!redis) return; // fail open: without memory the booking tools strip offsets
  try {
    await redis.set(key(sessionId), JSON.stringify(starts), 'PX', String(TTL_MS));
  } catch {
    // fail open
  }
}

export async function getOfferedSlots(sessionId: string): Promise<string[]> {
  const redis = getRedisClient();
  if (!redis) return [];
  try {
    const raw = await redis.get(key(sessionId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Resolve a booking time the model sent.
 *
 * Zoneless passes through untouched. Offset-bearing passes through ONLY when it names one of
 * the slots this session was actually offered; otherwise the suffix is stripped and the digits
 * are read as the business-local wall clock the customer said.
 */
export async function resolveBookingTime(sessionId: string, value: string): Promise<string> {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return value;
  const instant = Date.parse(value);
  if (Number.isFinite(instant)) {
    const offered = await getOfferedSlots(sessionId);
    const matchesOffered = offered.some((s) => {
      const offeredAt = Date.parse(s);
      return Number.isFinite(offeredAt) && Math.abs(offeredAt - instant) < 1000;
    });
    if (matchesOffered) return value;
  }
  logger.warn('[booking] offset-bearing time is not an offered slot; re-read as business wall clock', {
    sessionId,
    received: value,
    interpreted: value.replace(/(?:Z|[+-]\d{2}:?\d{2})$/i, ''),
  });
  return value.replace(/(?:Z|[+-]\d{2}:?\d{2})$/i, '');
}
