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
import { isRangedOverride, pickOverrideForDate } from '../../database/entities/AvailabilityRule';
import type { ServiceType } from '../../database/entities/ServiceType';
import type { BookingSlot, EmptyRangeDiagnosis } from './types';

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
    'durationMin' | 'bufferBeforeMin' | 'bufferAfterMin' | 'minNoticeMin' | 'maxHorizonDays' | 'maxBookingsPerDay'
  >;
  /** Query window (ISO UTC). */
  rangeStart: string;
  rangeEnd: string;
  /** Current instant — injectable for deterministic tests. */
  now: Date;
  /** Busy intervals (UTC) to subtract. Empty until bookings exist. */
  busy?: BusyInterval[];
  /**
   * Business-level ceilings. Applied ON TOP of the per-service values above — the stricter
   * of the two binds. Null/0 on any field means unlimited.
   */
  business?: {
    maxBookingsPerDay?: number | null;
    maxBookedMinutesPerDay?: number | null;
  };
  /**
   * This bot's HELD bookings in range, at their raw start/end — deliberately NOT `busy`.
   *
   * `busy` merges our bookings with the owner's personal calendar events and carries
   * buffer-expanded bounds, so counting it would refuse slots because someone has a dentist
   * appointment, and would bill their buffers as sold time. Day totals have to come from a
   * ledger of what the business actually booked.
   */
  dayLedger?: BusyInterval[];
  /**
   * This service's HELD bookings in range, at their raw start/end.
   *
   * Separate from `dayLedger` because a per-service cap must not count another
   * service's jobs, and separate from `busy` for the same reason the business
   * ledger is: buffers and the owner's personal calendar are not this service's
   * bookings.
   */
  serviceDayLedger?: BusyInterval[];
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

/** The day's hours ignoring date overrides — the weekly grid, or all day when always-open. */
function baseWindowsForDay(rule: SlotEngineInput['rule'], day: DateTime): TimeWindow[] {
  // Always-open: bookable around the clock; the calendar's busy intervals (passed
  // in `busy`) are the only limit. Weekly hours are ignored in this mode.
  if (rule.availabilityMode === 'always_open') return ALL_DAY;
  const key = WEEKDAY_KEYS[day.weekday - 1];
  return rule.weeklyHours?.[key] || [];
}

/**
 * Exported for the travel gate's start-from-base rule, which needs a day's first opening
 * instant and must not re-derive day hours. `dateOverrides` are authoritative — they replace
 * a day's hours, close a day the weekly pattern opens, and open one it does not — so a second
 * derivation reading `weeklyHours` alone would use an earlier opening than the day really has
 * (falsely clearing an unreachable first job) or find no window on a one-off opening and
 * suppress the check entirely.
 */
export function windowsForDay(rule: SlotEngineInput['rule'], day: DateTime): TimeWindow[] {
  const dateStr = day.toFormat('yyyy-MM-dd');
  // A multi-day closure is ONE row covering a range, so this is a containment test rather
  // than an equality one. `isWithinBusinessHours` shares this function, so analytics and the
  // scheduler cannot disagree about whether the business was shut. Narrowest row wins, so a
  // one-day exception typed inside a longer range beats it regardless of insertion order.
  const override = pickOverrideForDate(rule.dateOverrides, dateStr);
  if (override) {
    // A date override wins in every mode: a holiday closure still closes an
    // always-open business, and custom one-off hours still apply.
    if (override.closed) return [];
    // ...with one asymmetry between a single date and a RANGE. Naming one date is how an
    // owner opens a day they are normally shut — a one-off Sunday. A range is how they
    // restate the hours of a stretch ("short hours all fortnight"), and it is entered with
    // two date pickers and no weekday control, so applying it to every date it spans opened
    // the weekends inside it and the create path confirmed those bookings. A ranged
    // hours row therefore changes the hours of days already open and opens nothing new.
    if (isRangedOverride(override) && baseWindowsForDay(rule, day).length === 0) return [];
    return override.windows || [];
  }
  return baseWindowsForDay(rule, day);
}

function overlapsBusy(startMs: number, endMs: number, busy: BusyInterval[]): boolean {
  for (const b of busy) {
    if (startMs < b.end.getTime() && endMs > b.start.getTime()) return true;
  }
  return false;
}

/** Local calendar day key for an instant, e.g. "2026-08-04". */
const dayKeyOf = (ms: number, zone: string): string =>
  DateTime.fromMillis(ms, { zone }).toFormat('yyyy-MM-dd');

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

  // A slot may start no earlier than now + minNotice, and no later than now + horizon. ONE
  // definition, shared with `diagnoseEmptyRange`, so the bound the engine enforces and the
  // bound the customer is told about can never drift apart.
  const { earliestMs, latestMs: horizonMs } = bookableWindow(eventType, now);
  const earliestStartMs = Math.max(rangeStart.toMillis(), earliestMs);
  const rangeEndMs = rangeEnd.toMillis();

  // Iterate local calendar days across the (clamped) range.
  const firstDay = DateTime.fromMillis(Math.max(rangeStart.toMillis(), earliestStartMs), { zone })
    .setZone(zone)
    .startOf('day');
  const lastDay = DateTime.fromMillis(Math.min(rangeEndMs, horizonMs), { zone })
    .setZone(zone)
    .startOf('day');

  // Per-day usage from the ledger, so a day already at its business cap offers nothing
  // rather than offering a slot the create path will then refuse.
  const maxPerDay = input.business?.maxBookingsPerDay ?? 0;
  const maxMinutesPerDay = input.business?.maxBookedMinutesPerDay ?? 0;
  const usage = new Map<string, { count: number; minutes: number }>();
  if ((maxPerDay > 0 || maxMinutesPerDay > 0) && input.dayLedger?.length) {
    for (const b of input.dayLedger) {
      const key = dayKeyOf(b.start.getTime(), zone);
      const cur = usage.get(key) ?? { count: 0, minutes: 0 };
      cur.count += 1;
      cur.minutes += Math.max(0, (b.end.getTime() - b.start.getTime()) / 60_000);
      usage.set(key, cur);
    }
  }
  // Per-service daily cap. Null/0 = unlimited, matching the create-path gate.
  const serviceMax = input.eventType.maxBookingsPerDay ?? 0;
  const serviceUsage = new Map<string, number>();
  if (serviceMax > 0 && input.serviceDayLedger?.length) {
    for (const b of input.serviceDayLedger) {
      const key = dayKeyOf(b.start.getTime(), zone);
      serviceUsage.set(key, (serviceUsage.get(key) ?? 0) + 1);
    }
  }

  const slots: BookingSlot[] = [];
  const seen = new Set<number>();

  // Hard cap on day iteration as a runaway guard (horizon already bounds it).
  let guard = 0;
  for (let day = firstDay; day <= lastDay && guard < 400; day = day.plus({ days: 1 }), guard++) {
    const used = usage.get(day.toFormat('yyyy-MM-dd')) ?? { count: 0, minutes: 0 };
    // Whole-day skips: no point walking the windows of a day that is already full.
    if (maxPerDay > 0 && used.count >= maxPerDay) continue;
    if (maxMinutesPerDay > 0 && used.minutes + duration > maxMinutesPerDay) continue;
    if (serviceMax > 0 && (serviceUsage.get(day.toFormat('yyyy-MM-dd')) ?? 0) >= serviceMax) continue;

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
 * The window a slot start must fall inside: `[now + minNotice, now + maxHorizon]`.
 *
 * Exported because two callers have to agree on it exactly - `computeSlots` enforces it and
 * `diagnoseEmptyRange` explains it. A second copy of this arithmetic could drift and send a
 * customer back on a day the engine still refuses.
 */
export function bookableWindow(
  eventType: Pick<ServiceType, 'minNoticeMin' | 'maxHorizonDays'>,
  now: Date
): { earliestMs: number; latestMs: number } {
  const nowDt = DateTime.fromJSDate(now).toUTC();
  return {
    earliestMs: nowDt.plus({ minutes: eventType.minNoticeMin || 0 }).toMillis(),
    latestMs: nowDt.plus({ days: eventType.maxHorizonDays || 0 }).toMillis(),
  };
}

/** Far enough ahead to lift the horizon in practice. The day walk is capped independently. */
const NO_HORIZON_DAYS = 3650;

/**
 * WHY a range produced nothing, when the answer is the owner's own notice/horizon/cap policy.
 *
 * An empty range has two very different causes and one of them used to be invisible. A shut or
 * full diary genuinely has nothing to offer. A range the POLICY ruled out is full of times this
 * business would happily take on another day - and told only `slots: []`, the caller advised a
 * manual request, which drops an auto-book service into a flow its owner never chose.
 *
 * Notice and horizon: THE SAME RANGE, THE SAME DIARY, THE SAME CAPS, with only those two lifted.
 * Service daily cap: the same range with only that cap lifted. Either way it is one pure pass
 * over data the caller has already loaded, so it costs no query, and it cannot disagree with the
 * real pass about opening hours, buffers or busy time - it runs the same engine.
 *
 * Null unless EVERY would-be start falls on one side of the window, or the only thing that
 * emptied the range is this service's daily cap. A range holding even one policy-allowed start
 * that busy time removed is an ordinary empty range, and calling it "too soon" would be false.
 */
export function diagnoseEmptyRange(input: SlotEngineInput): EmptyRangeDiagnosis | null {
  const windowReason = (slots: BookingSlot[]): EmptyRangeDiagnosis | null => {
    if (slots.length === 0) return null;
    const { earliestMs, latestMs } = bookableWindow(input.eventType, input.now);
    const starts = slots.map((s) => new Date(s.start).getTime());
    if (starts.every((ms) => ms < earliestMs)) {
      return { reason: 'too_soon', boundary: new Date(earliestMs).toISOString() };
    }
    if (starts.every((ms) => ms > latestMs)) {
      return { reason: 'too_far', boundary: new Date(latestMs).toISOString() };
    }
    return null;
  };

  const wouldBe = computeSlots({
    ...input,
    eventType: { ...input.eventType, minNoticeMin: 0, maxHorizonDays: NO_HORIZON_DAYS },
  });
  const fromWindow = windowReason(wouldBe);
  if (fromWindow) return fromWindow;
  if (wouldBe.length > 0) return null; // mixed, or the range actually has bookable starts

  const cap = input.eventType.maxBookingsPerDay ?? 0;
  if (cap > 0) {
    const uncapped = computeSlots({
      ...input,
      eventType: { ...input.eventType, maxBookingsPerDay: 0 },
    });
    if (uncapped.length > 0) {
      return { reason: 'service_day_full', boundary: new Date(input.rangeEnd).toISOString() };
    }
    // Cap AND notice/horizon together: prefer the window reason so we do not send the
    // customer back to a day that is also too soon.
    return windowReason(
      computeSlots({
        ...input,
        eventType: {
          ...input.eventType,
          maxBookingsPerDay: 0,
          minNoticeMin: 0,
          maxHorizonDays: NO_HORIZON_DAYS,
        },
      }),
    );
  }
  return null; // shut, full, or entirely in the past
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
