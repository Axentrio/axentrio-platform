/**
 * One-way sync: Bot.settings.businessHours → AvailabilityRule hours.
 *
 * Spoken hours (the AI bot form) and bookable slots (the internal scheduler)
 * used to be two unsynced stores. A Thursday marked closed on the bot form was
 * spoken as a holiday while the slot engine still offered Thursday times.
 *
 * This mapper is the write-side fix. PATCH /bots/:id applies it to an existing
 * AvailabilityRule when businessHours is saved. It never creates a rule — a
 * non-booking bot has nothing to update. It replaces only `weeklyHours` and
 * `dateOverrides`; availabilityMode, timezone, slot granularity and every
 * booking-rules field stay put.
 *
 * A later manual edit in SchedulerSettings will be overwritten by the next
 * bot-form hours save. That is accepted and called out in the scheduler copy.
 *
 * Semantics
 * ---------
 * Weekly schedule (full weekday names, one open/close pair per day):
 *   - `closed: true` or a missing day → no window that weekday (key omitted).
 *     The slot engine treats a missing/empty key as closed.
 *   - `closed: false` → one window `{ start: open, end: close }`.
 *
 * Date overrides (already the AvailabilityRule DateOverride shape):
 *   - `closed: true` → closed that date or inclusive range. Windows are
 *     dropped so a holiday cannot stay bookable.
 *   - windows and not closed → one-off hours that replace the weekly grid
 *     for that date/range.
 *   - neither closed nor windows → treated as closed (no slots).
 *   - a missing `dateOverrides` key → `[]` (the bot form is the authority;
 *     unspoken exceptions must not keep blocking slots).
 */
import type {
  DateOverride,
  TimeWindow,
  Weekday,
  WeeklyHours,
} from '../database/entities/AvailabilityRule';

const FULL_DAY_TO_WEEKDAY: Record<string, Weekday> = {
  monday: 'mon',
  tuesday: 'tue',
  wednesday: 'wed',
  thursday: 'thu',
  friday: 'fri',
  saturday: 'sat',
  sunday: 'sun',
};

export interface SpokenHoursDay {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}

export interface SpokenHours {
  schedule?: SpokenHoursDay[] | null;
  dateOverrides?: DateOverride[] | null;
}

export interface AvailabilityHours {
  weeklyHours: WeeklyHours;
  dateOverrides: DateOverride[];
}

function mapWindow(w: TimeWindow): TimeWindow {
  return { start: w.start, end: w.end };
}

function mapOverride(raw: DateOverride): DateOverride | null {
  if (!raw || typeof raw.date !== 'string' || !raw.date) return null;

  const out: DateOverride = { date: raw.date };
  if (typeof raw.endDate === 'string' && raw.endDate) {
    out.endDate = raw.endDate;
  }

  if (raw.closed) {
    out.closed = true;
    return out;
  }

  if (Array.isArray(raw.windows) && raw.windows.length > 0) {
    out.windows = raw.windows.map(mapWindow);
    return out;
  }

  // Neither a holiday flag nor replacement hours: fail closed so the day
  // cannot stay bookable under a half-specified exception.
  out.closed = true;
  return out;
}

/**
 * Map spoken business hours onto the two AvailabilityRule fields that gate slots.
 * Pure. Does not read or write the database.
 */
export function businessHoursToAvailability(bh: SpokenHours | null | undefined): AvailabilityHours {
  const weeklyHours: WeeklyHours = {};

  for (const day of bh?.schedule ?? []) {
    if (!day || day.closed) continue;
    const key = FULL_DAY_TO_WEEKDAY[day.day];
    if (!key) continue;
    if (typeof day.open !== 'string' || typeof day.close !== 'string') continue;
    if (!day.open || !day.close) continue;
    weeklyHours[key] = [{ start: day.open, end: day.close }];
  }

  const dateOverrides = (bh?.dateOverrides ?? [])
    .map(mapOverride)
    .filter((o): o is DateOverride => o !== null);

  return { weeklyHours, dateOverrides };
}
