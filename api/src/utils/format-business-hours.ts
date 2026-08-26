import {
  isRelevantOn,
  overrideSpanEnd,
  pickOverrideForDate,
  type DateOverride,
} from '../database/entities/AvailabilityRule';

/**
 * Renders `Bot.settings.businessHours` for the `{openingHours}` placeholder.
 *
 * Operational hours are the authoritative source for `{openingHours}` whenever they
 * are configured/enabled. The booking AvailabilityRule is only a fallback for that
 * placeholder, and still the sole source for slot computation. `{bookingHours}` is
 * a separate placeholder and always uses the AvailabilityRule.
 *
 * Pure. Disabled / empty / all-closed → '' (fail-closed, never a literal {key}).
 */

export interface BusinessHoursDay {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}

export interface BusinessHours {
  enabled: boolean;
  timezone?: string;
  schedule: BusinessHoursDay[];
  /**
   * One-off exceptions to the weekly schedule — the same Date Override shape
   * the booking Availability Rule already stores. A closed date, or different
   * hours on a date. Absent/empty = weekly schedule only.
   */
  dateOverrides?: DateOverride[];
}

const DAY_LABEL: Record<string, string> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};

/** Configured in the bot form and enabled — the spoken-hours source of truth. */
export function isBusinessHoursConfigured(bh?: BusinessHours | null): bh is BusinessHours {
  return !!bh?.enabled && Array.isArray(bh.schedule);
}

function localDateInZone(now: Date, timezone: string): string {
  try {
    const dateParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const y = dateParts.find((p) => p.type === 'year')?.value;
    const m = dateParts.find((p) => p.type === 'month')?.value;
    const d = dateParts.find((p) => p.type === 'day')?.value;
    return y && m && d ? `${y}-${m}-${d}` : '';
  } catch {
    // Invalid IANA zone — omit closures rather than crash prompt composition.
    return '';
  }
}

const WEEKDAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

function windowsNote(o: DateOverride): string {
  return (Array.isArray(o.windows) ? o.windows : [])
    .filter((w) => w && typeof w.start === 'string' && typeof w.end === 'string' && w.start && w.end)
    .map((w) => `${w.start}–${w.end}`)
    .join(', ');
}

/** Compact override notes for `{openingHours}`: closures AND one-off hours, cap 3. */
function overrideNotes(overrides: DateOverride[] | undefined, today: string): string {
  return (Array.isArray(overrides) ? overrides : [])
    .filter((o) => {
      if (!o || typeof o.date !== 'string' || !today || !isRelevantOn(o, today)) return false;
      return !!o.closed || !!windowsNote(o);
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3)
    .map((o) => {
      const end = overrideSpanEnd(o);
      const span = end ? `${o.date} to ${end}` : o.date;
      if (o.closed) return `closed ${span}`;
      return `${span} open ${windowsNote(o)}`;
    })
    .join(' · ');
}

/** e.g. "Mon 09:00–17:00, Wed closed". Closed weekdays are named so "yesterday" can bind. */
export function formatBusinessHoursForPlaceholder(
  bh?: BusinessHours | null,
  now: Date = new Date(),
  /** Bot.businessTimezone — "today" for closures must be the business's local date, not UTC. */
  timezone: string = 'UTC',
): string {
  if (!isBusinessHoursConfigured(bh)) return '';
  const weekly = WEEKDAY_KEYS.map((key) => {
    const d = bh.schedule.find((s) => s && typeof s.day === 'string' && s.day.toLowerCase() === key);
    const label = DAY_LABEL[key];
    if (!d || d.closed || typeof d.open !== 'string' || typeof d.close !== 'string' || !d.open || !d.close) {
      return `${label} closed`;
    }
    return `${label} ${d.open}–${d.close}`;
  }).join(', ');

  // Overrides are part of the answer: otherwise `{openingHours}` quotes the weekly
  // grid on a day the owner marked closed or opened with one-off hours. "Today" is
  // the local calendar date in the business timezone — UTC dropped a still-current
  // holiday after midnight Z.
  const today = localDateInZone(now, timezone);
  const notes = overrideNotes(bh.dateOverrides, today);
  if (!notes) return weekly;
  return weekly ? `${weekly} · ${notes}` : notes;
}

/**
 * Is the business currently OUTSIDE its configured hours?
 *
 * The single source of truth for "closed right now", used by BOTH the off-hours
 * gate and the `## AVAILABILITY` prompt fact, so the two can never disagree. It
 * reproduces the gate's original math: the local day + time in the business
 * timezone versus the day's schedule.
 *
 * `timezone` is EXPLICIT and required: callers pass the bot's canonical
 * `businessTimezone` (server-owned, geography-derived). The legacy
 * `bh.timezone` is deliberately ignored — it was written from the
 * configurator's browser clock, which is exactly the authority this predicate
 * must not consult.
 *
 * Date Overrides (closed days / one-off hours) replace the weekly schedule
 * for the local calendar date they cover — same `pickOverrideForDate` the
 * booking engine uses, so the two cannot disagree about a holiday.
 *
 * Returns FALSE — treat as OPEN, never announce "closed" — whenever hours are
 * disabled, the schedule is empty, the timezone is missing/invalid (Intl
 * throws), a day's open/close is malformed, or an exception is present but
 * unusable. Failing safe toward engaging the customer is always better than
 * a wrong "we are closed".
 */
export function isOutsideBusinessHours(
  bh: BusinessHours | null | undefined,
  timezone: string,
  now: Date = new Date(),
): boolean {
  if (!bh?.enabled || !Array.isArray(bh.schedule) || bh.schedule.length === 0) return false;
  if (!timezone) return false; // no trustworthy timezone → treat as open
  try {
    const tz = timezone;
    const dayName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now).toLowerCase();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const minute = parts.find((p) => p.type === 'minute')?.value;
    if (!hour || !minute) return false;
    const timeStr = `${hour}:${minute}`;
    const dateParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const y = dateParts.find((p) => p.type === 'year')?.value;
    const m = dateParts.find((p) => p.type === 'month')?.value;
    const d = dateParts.find((p) => p.type === 'day')?.value;
    const dateStr = y && m && d ? `${y}-${m}-${d}` : '';
    // A well-formed Date Override replaces the weekly schedule for that local
    // date. Malformed / missing exceptions are ignored (fail-safe to the weekly
    // grid, never a wrong "closed").
    const override = dateStr ? pickOverrideForDate(bh.dateOverrides, dateStr) : undefined;
    if (override) {
      if (override.closed) return true;
      const windows = Array.isArray(override.windows) ? override.windows : [];
      const usable = windows.filter(
        (w) => w && typeof w.start === 'string' && typeof w.end === 'string' && w.start && w.end,
      );
      if (usable.length === 0) return false; // override present but hours unusable → open
      return usable.every((w) => timeStr < w.start || timeStr >= w.end);
    }
    const daySchedule = bh.schedule.find(
      (s) => s && typeof s.day === 'string' && s.day.toLowerCase() === dayName,
    );
    if (!daySchedule || daySchedule.closed) return true; // no entry for today, or explicitly closed
    if (typeof daySchedule.open !== 'string' || typeof daySchedule.close !== 'string') return false; // malformed → open
    return timeStr < daySchedule.open || timeStr >= daySchedule.close;
  } catch {
    return false; // invalid timezone or any unexpected shape → treat as open
  }
}
