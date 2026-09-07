/**
 * Bidirectional hours sync: Bot.settings.businessHours ↔ AvailabilityRule hours.
 *
 * Spoken hours (the AI bot form) and bookable slots (the internal scheduler)
 * used to be two unsynced stores. A Thursday marked closed on the bot form was
 * spoken as a holiday while the slot engine still offered Thursday times.
 *
 * `businessHoursToAvailability` is the bot-form write-side fix. PATCH /bots/:id
 * applies it to an existing AvailabilityRule when businessHours is saved. It
 * never creates a rule — a non-booking bot has nothing to update. It replaces
 * only `weeklyHours` and `dateOverrides`; availabilityMode, timezone, slot
 * granularity and every booking-rules field stay put.
 *
 * `availabilityToBusinessHours` is the inverse, for PUT /scheduler/config.
 * Last-write-wins between the two editors; each direction is a one-shot write
 * inside its own request and cannot loop.
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

const WEEKDAY_TO_FULL_DAY: Record<Weekday, string> = {
  mon: 'monday',
  tue: 'tuesday',
  wed: 'wednesday',
  thu: 'thursday',
  fri: 'friday',
  sat: 'saturday',
  sun: 'sunday',
};

const WEEKDAY_ORDER: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DEFAULT_SPOKEN_OPEN = '09:00';
const DEFAULT_SPOKEN_CLOSE = '17:00';

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

/** The spoken-hours half of an AvailabilityRule write, for `PUT /scheduler/config`. */
export interface SpokenHoursPatch {
  schedule: Array<{ day: string; open: string; close: string; closed: boolean }>;
  dateOverrides: DateOverride[];
}

function envelopeOf(windows: TimeWindow[] | undefined): { open: string; close: string } | null {
  if (!Array.isArray(windows) || windows.length === 0) return null;
  let open: string | null = null;
  let close: string | null = null;
  for (const w of windows) {
    if (!w || typeof w.start !== 'string' || typeof w.end !== 'string') continue;
    if (!w.start || !w.end) continue;
    if (open === null || w.start < open) open = w.start;
    if (close === null || w.end > close) close = w.end;
  }
  return open && close ? { open, close } : null;
}

/**
 * Map an AvailabilityRule hours write onto the spoken-hours schedule
 * `{openingHours}` reads. Pure. Does not read or write the database.
 *
 * Inverse of `businessHoursToAvailability`. A split-shift day collapses to the
 * earliest start and latest end because `businessHours` holds one pair per day.
 * Closed days keep the stored clock text so toggling a day back open does not
 * silently rewrite the owner's times. Unrecognised stored day keys are treated
 * as absent rather than written back in a shape the schema would reject.
 */
export function availabilityToBusinessHours(
  availability: {
    weeklyHours?: WeeklyHours | null;
    /** Scheduler writes allow `endDate: null` (clear); DateOverride omits the key. */
    dateOverrides?: ReadonlyArray<{
      date: string;
      endDate?: string | null;
      closed?: boolean;
      windows?: TimeWindow[];
    }> | null;
  },
  /** The stored schedule, so a closed day keeps the owner's own clock text. */
  stored?: Array<{ day: string; open: string; close: string; closed: boolean }> | null,
): SpokenHoursPatch {
  const weekly = availability.weeklyHours ?? {};
  const storedByDay = new Map<string, { open: string; close: string }>();
  for (const day of stored ?? []) {
    if (!day || typeof day.day !== 'string') continue;
    if (!(day.day in FULL_DAY_TO_WEEKDAY)) continue;
    if (typeof day.open !== 'string' || typeof day.close !== 'string') continue;
    if (!day.open || !day.close) continue;
    storedByDay.set(day.day, { open: day.open, close: day.close });
  }

  const schedule = WEEKDAY_ORDER.map((weekday) => {
    const fullDay = WEEKDAY_TO_FULL_DAY[weekday];
    const span = envelopeOf(weekly[weekday]);
    if (span) {
      return { day: fullDay, open: span.open, close: span.close, closed: false };
    }
    const clocks = storedByDay.get(fullDay);
    return {
      day: fullDay,
      open: clocks?.open ?? DEFAULT_SPOKEN_OPEN,
      close: clocks?.close ?? DEFAULT_SPOKEN_CLOSE,
      closed: true,
    };
  });

  return {
    schedule,
    dateOverrides: (availability.dateOverrides ?? []).map((o) => {
      const { endDate, ...rest } = o;
      const out: DateOverride = { ...rest };
      if (typeof endDate === 'string' && endDate) out.endDate = endDate;
      return out;
    }),
  };
}
