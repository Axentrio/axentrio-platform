/**
 * Local dates `check_availability` has already looked at in this conversation.
 *
 * Distinct from offered-slots: that store records a *successful* check with
 * slots. An empty or failed check is precisely when a Request is legitimate,
 * so this one records the attempt itself — before the provider runs.
 *
 * Same Redis fail-open as refused-named-time: no store means callers treat the
 * date as unchecked-unknown (`null`) and stand down.
 */
import { DateTime } from 'luxon';
import { getRedisClient } from '../../config/redis';

const key = (sessionId: string): string => `booking:availability-checked:${sessionId}`;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 31; // one call may record at most this many dates
const MAX_DATES = 120; // per session; drop oldest beyond this
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function datesInRange(startDate: string, endDate: string): string[] {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) return [];
  const start = DateTime.fromISO(startDate, { zone: 'utc' });
  if (!start.isValid) return [];
  const endRaw = DateTime.fromISO(endDate, { zone: 'utc' });
  if (!endRaw.isValid || endRaw < start) return [start.toFormat('yyyy-MM-dd')];
  const last = start.plus({ days: MAX_RANGE_DAYS - 1 });
  const end = endRaw > last ? last : endRaw;
  const out: string[] = [];
  for (let d = start; d <= end; d = d.plus({ days: 1 })) {
    out.push(d.toFormat('yyyy-MM-dd'));
  }
  return out;
}

/** Record every local date in [startDate, endDate] (yyyy-MM-dd, inclusive). Invalid input is ignored. */
export async function rememberAvailabilityChecked(
  sessionId: string,
  startDate: string,
  endDate: string,
): Promise<void> {
  const added = datesInRange(startDate, endDate);
  if (added.length === 0) return;
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const raw = await redis.get(key(sessionId));
    let prev: string[] = [];
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        prev = parsed.filter((d): d is string => typeof d === 'string');
      }
    }
    const seen = new Set(prev);
    for (const d of added) seen.add(d);
    const dates = [...seen];
    const trimmed = dates.length > MAX_DATES ? dates.slice(dates.length - MAX_DATES) : dates;
    await redis.set(key(sessionId), JSON.stringify(trimmed), 'PX', String(TTL_MS));
  } catch {
    // fail open
  }
}

/** Dates recorded for this session; `null` when the store is unreachable (callers fail open). */
export async function peekAvailabilityChecked(sessionId: string): Promise<string[] | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(key(sessionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === 'string');
  } catch {
    return null;
  }
}

/** Convenience over peek: true / false / null (store down). */
export async function availabilityCheckedFor(
  sessionId: string,
  localDate: string,
): Promise<boolean | null> {
  const dates = await peekAvailabilityChecked(sessionId);
  if (dates === null) return null;
  return dates.includes(localDate);
}
