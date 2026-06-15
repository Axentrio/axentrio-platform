/**
 * Slot engine — pure, timezone/DST-aware availability computation.
 *
 * Expands an availability rule (weekly hours + date overrides, in the owner's
 * timezone) into concrete bookable UTC slots for an event type, applying
 * buffers, minimum notice, max horizon, and subtracting busy intervals
 * (confirmed bookings + external calendar busy, supplied by the caller).
 *
 * `now` is injected so tests can freeze the clock. All outputs are UTC ISO.
 *
 * DST handling:
 *  - spring-forward gap → the nonexistent local time is skipped.
 *  - fall-back overlap → the first (earlier-offset) occurrence is used (luxon default).
 */
import { DateTime } from 'luxon';
import type {
  AvailabilityRule,
  TimeWindow,
  Weekday,
} from '../../database/entities/AvailabilityRule';
import type { ServiceType } from '../../database/entities/ServiceType';
import type { BookingSlot } from './types';

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface SlotEngineInput {
  rule: Pick<
    AvailabilityRule,
    'timezone' | 'weeklyHours' | 'dateOverrides' | 'slotGranularityMin' | 'availabilityMode'
  >;
  eventType: Pick<
    ServiceType,
    'durationMin' | 'bufferBeforeMin' | 'bufferAfterMin' | 'minNoticeMin' | 'maxHorizonDays'
  >;
  /** Query window (ISO UTC). */
  rangeStart: string;
  rangeEnd: string;
  /** Current instant — injectable for deterministic tests. */
  now: Date;
  /** Busy intervals (UTC) to subtract. Empty until bookings exist. */
  busy?: BusyInterval[];
}

const WEEKDAY_KEYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Construct a local wall-clock time on a given day in a zone. Returns null when
 * the time does not exist (DST spring-forward gap), so callers skip it.
 */
function localTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string
): DateTime | null {
  const dt = DateTime.fromObject({ year, month, day, hour, minute }, { zone });
  if (!dt.isValid) return null;
  // Luxon advances times that fall in a DST gap; detect and skip them.
  if (dt.hour !== hour || dt.minute !== minute) return null;
  return dt;
}

function parseHHMM(s: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  // Allow "24:00" as an end-of-day marker (1440 minutes).
  if (h < 0 || h > 24 || m < 0 || m > 59 || (h === 24 && m !== 0)) return null;
  return { h, m };
}

/** A full calendar day (00:00–24:00) — the implicit window in `always_open` mode. */
const ALL_DAY: TimeWindow[] = [{ start: '00:00', end: '24:00' }];

function windowsForDay(rule: SlotEngineInput['rule'], day: DateTime): TimeWindow[] {
  const dateStr = day.toFormat('yyyy-MM-dd');
  const override = (rule.dateOverrides || []).find((o) => o.date === dateStr);
  if (override) {
    // A date override wins in every mode: a holiday closure still closes an
    // always-open business, and custom one-off hours still apply.
    if (override.closed) return [];
    return override.windows || [];
  }
  // Always-open: bookable around the clock; the calendar's busy intervals (passed
  // in `busy`) are the only limit. Weekly hours are ignored in this mode.
  if (rule.availabilityMode === 'always_open') return ALL_DAY;
  const key = WEEKDAY_KEYS[day.weekday - 1];
  return rule.weeklyHours?.[key] || [];
}

function overlapsBusy(startMs: number, endMs: number, busy: BusyInterval[]): boolean {
  for (const b of busy) {
    if (startMs < b.end.getTime() && endMs > b.start.getTime()) return true;
  }
  return false;
}

export function computeSlots(input: SlotEngineInput): BookingSlot[] {
  const { rule, eventType, now } = input;
  const zone = rule.timezone || 'UTC';
  const busy = input.busy || [];
  const granularity = Math.max(1, rule.slotGranularityMin || 30);
  const duration = eventType.durationMin;
  const bufferBeforeMs = (eventType.bufferBeforeMin || 0) * 60_000;
  const bufferAfterMs = (eventType.bufferAfterMin || 0) * 60_000;

  const rangeStart = DateTime.fromISO(input.rangeStart, { zone: 'utc' });
  const rangeEnd = DateTime.fromISO(input.rangeEnd, { zone: 'utc' });
  if (!rangeStart.isValid || !rangeEnd.isValid || rangeEnd <= rangeStart) return [];

  const nowDt = DateTime.fromJSDate(now).toUTC();
  // A slot may start no earlier than now + minNotice, and no later than now + horizon.
  const earliestStartMs = Math.max(
    rangeStart.toMillis(),
    nowDt.plus({ minutes: eventType.minNoticeMin || 0 }).toMillis()
  );
  const horizonMs = nowDt.plus({ days: eventType.maxHorizonDays || 0 }).toMillis();
  const rangeEndMs = rangeEnd.toMillis();

  // Iterate local calendar days across the (clamped) range.
  const firstDay = DateTime.fromMillis(Math.max(rangeStart.toMillis(), earliestStartMs), { zone })
    .setZone(zone)
    .startOf('day');
  const lastDay = DateTime.fromMillis(Math.min(rangeEndMs, horizonMs), { zone })
    .setZone(zone)
    .startOf('day');

  const slots: BookingSlot[] = [];
  const seen = new Set<number>();

  // Hard cap on day iteration as a runaway guard (horizon already bounds it).
  let guard = 0;
  for (let day = firstDay; day <= lastDay && guard < 400; day = day.plus({ days: 1 }), guard++) {
    for (const window of windowsForDay(rule, day)) {
      const ws = parseHHMM(window.start);
      const we = parseHHMM(window.end);
      if (!ws || !we) continue;
      const winStartMin = ws.h * 60 + ws.m;
      const winEndMin = we.h * 60 + we.m;
      if (winEndMin <= winStartMin) continue;

      for (let startMin = winStartMin; startMin + duration <= winEndMin; startMin += granularity) {
        const hour = Math.floor(startMin / 60);
        const minute = startMin % 60;
        const startLocal = localTime(day.year, day.month, day.day, hour, minute, zone);
        if (!startLocal) continue; // DST gap → skip

        const startUtc = startLocal.toUTC();
        const endUtc = startUtc.plus({ minutes: duration });
        const startMs = startUtc.toMillis();
        const endMs = endUtc.toMillis();

        if (startMs < earliestStartMs) continue; // past or inside min-notice
        if (startMs > horizonMs) continue; // beyond max horizon
        if (startMs < rangeStart.toMillis() || startMs >= rangeEndMs) continue; // outside query window
        if (overlapsBusy(startMs - bufferBeforeMs, endMs + bufferAfterMs, busy)) continue;
        if (seen.has(startMs)) continue;

        seen.add(startMs);
        slots.push({ start: startUtc.toISO()!, end: endUtc.toISO()! });
      }
    }
  }

  slots.sort((a, b) => a.start.localeCompare(b.start));
  return slots;
}

/**
 * Is `at` inside the rule's business hours? Reuses the same window math as
 * slot computation (weekly hours + date overrides + "24:00" end-of-day, in
 * the owner's timezone) so "after hours" in analytics can never drift from
 * "bookable hours" in the scheduler. Pure; used by the outcome metrics.
 */
export function isWithinBusinessHours(
  rule: Pick<AvailabilityRule, 'timezone' | 'weeklyHours' | 'dateOverrides' | 'availabilityMode'>,
  at: Date,
): boolean {
  const zone = rule.timezone || 'UTC';
  const dt = DateTime.fromJSDate(at, { zone });
  if (!dt.isValid) return false;
  // always_open → the full-day window covers every instant (minus override closures),
  // so a 24/7 business never has "after hours" in analytics.
  const windows = windowsForDay({ ...rule, slotGranularityMin: 0 }, dt);
  const minutesOfDay = dt.hour * 60 + dt.minute;
  for (const w of windows) {
    const start = parseHHMM(w.start);
    const end = parseHHMM(w.end);
    if (!start || !end) continue;
    if (minutesOfDay >= start.h * 60 + start.m && minutesOfDay < end.h * 60 + end.m) return true;
  }
  return false;
}
