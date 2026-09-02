/**
 * A named booking time the notice/horizon policy refused, remembered for this
 * conversation so the next turn does not treat the clock as already chosen.
 *
 * Same Redis fail-open as offered slots: no store means the in-run flag is the
 * only latch, and a later "ja" can match the hour again.
 */
import { DateTime } from 'luxon';
import { getRedisClient } from '../config/redis';
import { parseCalendarDates, parseWeekdays } from './clock-times';

export interface RefusedNamedTime {
  localDate: string;
  clock: string;
}

const key = (sessionId: string): string => `booking:refused-date:${sessionId}`;
const TTL_MS = 24 * 60 * 60 * 1000;

export async function rememberRefusedNamedTime(
  sessionId: string,
  localDate: string,
  clock: string,
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !/^\d{2}:\d{2}$/.test(clock)) return;
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const payload: RefusedNamedTime = { localDate, clock };
    await redis.set(key(sessionId), JSON.stringify(payload), 'PX', String(TTL_MS));
  } catch {
    // fail open
  }
}

export async function peekRefusedNamedTime(sessionId: string): Promise<RefusedNamedTime | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(key(sessionId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as RefusedNamedTime).localDate === 'string' &&
      typeof (parsed as RefusedNamedTime).clock === 'string'
    ) {
      return parsed as RefusedNamedTime;
    }
    return null;
  } catch {
    return null;
  }
}

export async function clearRefusedNamedTime(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(key(sessionId));
  } catch {
    // fail open
  }
}

/**
 * True when this live message left the refused date: a different calendar day,
 * or a weekday that is not that day's weekday ("dinsdag dan"). Bare "ja" stays.
 */
export function customerMovedOffRefusedDate(text: string, refused: RefusedNamedTime): boolean {
  const fallbackYear = Number(refused.localDate.slice(0, 4));
  const dates = parseCalendarDates(text, fallbackYear);
  if (dates.some((d) => d === refused.localDate)) return false;
  if (dates.length > 0) return true;
  const refusedWeekday = DateTime.fromISO(refused.localDate).weekday;
  const weekdays = parseWeekdays(text);
  if (weekdays.length > 0 && !weekdays.includes(refusedWeekday)) return true;
  return false;
}

export async function refusedNamedTimeStillApplies(
  sessionId: string,
  liveMessage: string,
): Promise<boolean> {
  const refused = await peekRefusedNamedTime(sessionId);
  if (!refused) return false;
  if (customerMovedOffRefusedDate(liveMessage, refused)) {
    await clearRefusedNamedTime(sessionId);
    return false;
  }
  return true;
}
