/**
 * Which half of a day a Slot sits in (#82's period model, used by #81's scorer).
 *
 * Half Day grouping prefers a Slot near the jobs an owner already has that MORNING or that
 * AFTERNOON, so their day clusters instead of scattering. Everything downstream needs one thing
 * from this file: given a day and a candidate, which period is it in, and is there a period at
 * all. Getting that wrong does not produce a wrong drive time - it produces a preference computed
 * against the wrong set of neighbours, which is worse, because it looks like an answer.
 *
 * Contract: `docs/specs/location-aware-planning.md`, "The half-day boundary".
 */
import { DateTime } from 'luxon';
import type { TimeWindow } from '../../database/entities/AvailabilityRule';

export type HalfDayPeriod = 'morning' | 'afternoon';

export interface DayPeriods {
  /** The instant separating the two periods, in UTC. */
  boundary: Date;
  /** The day's first opening instant and last closing instant, in UTC. */
  dayStart: Date;
  dayEnd: Date;
  /**
   * A boundary worth OFFERING the owner, when the day has a gap that looks more like their real
   * division than the clock does. Suggested only - see `suggestedBoundary` below.
   */
  suggested?: Date;
}

/** Minutes past midnight for an `HH:MM` window edge, or null when it is malformed. */
function minutesOf(hhmm: string | undefined): number | null {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

const instantAt = (localDay: string, minutes: number, timezone: string): Date =>
  DateTime.fromISO(localDay, { zone: timezone })
    .startOf('day')
    .plus({ minutes })
    .toUTC()
    .toJSDate();

/**
 * The day's two periods, or null when the day has no shape to divide.
 *
 * NULL IS A REAL ANSWER and callers must treat it as "do not group", never as "one big period".
 * Two cases produce it, and both are in the contract:
 *
 *   - **No effective windows.** A closed day has no morning.
 *   - **`always_open`.** A day with no shape has no midpoint either, and 12:00 would be an
 *     invention - the owner never said it. Full Day would still apply to such a day, because a day
 *     is still a day; Half Day does not.
 *
 * The default boundary is the MIDPOINT BETWEEN THE FIRST OPENING AND THE LAST CLOSING, not the
 * midpoint of elapsed open time across the union of windows. An owner who says "morning" means the
 * clock. A business open 08:00-10:00 and 14:00-18:00 has six open hours whose midpoint sits at
 * 16:00, which no one would call the start of their afternoon; the clock midpoint is 13:00.
 */
export function resolveDayPeriods(input: {
  /** Local calendar day, `YYYY-MM-DD`. */
  localDay: string;
  timezone: string;
  /** The day's effective windows, date overrides already applied (`windowsForDay`). */
  windows: TimeWindow[];
  /** `always_open` disables Half Day entirely. */
  alwaysOpen: boolean;
  /** The owner's explicit boundary as `HH:MM`, when they have set one. */
  boundaryOverride?: string | null;
}): DayPeriods | null {
  if (input.alwaysOpen) return null;

  const edges = input.windows
    .map((w) => ({ start: minutesOf(w.start), end: minutesOf(w.end) }))
    .filter((w): w is { start: number; end: number } => w.start !== null && w.end !== null && w.end > w.start)
    .sort((a, b) => a.start - b.start);
  if (!edges.length) return null;

  const first = edges[0].start;
  const last = edges[edges.length - 1].end;

  const override = minutesOf(input.boundaryOverride ?? undefined);
  // An override outside the day is ignored rather than honoured: a boundary before opening or
  // after closing would put every Slot in one period and silently disable grouping, which is a
  // configuration mistake that should not look like a working setting.
  const useOverride = override !== null && override > first && override < last;
  const boundaryMinutes = useOverride ? override : Math.round((first + last) / 2);

  const periods: DayPeriods = {
    boundary: instantAt(input.localDay, boundaryMinutes, input.timezone),
    dayStart: instantAt(input.localDay, first, input.timezone),
    dayEnd: instantAt(input.localDay, last, input.timezone),
  };

  const suggestion = suggestedBoundary(edges);
  // Only worth suggesting when it differs from what is already in force. Offering the owner the
  // boundary they already have is noise.
  if (suggestion !== null && suggestion !== boundaryMinutes) {
    periods.suggested = instantAt(input.localDay, suggestion, input.timezone);
  }
  return periods;
}

/**
 * The largest gap between windows, as a boundary to OFFER the owner. Never applied automatically.
 *
 * Two windows may be a school run rather than a morning and an afternoon, and the system cannot
 * tell which. Applying it would silently redefine the owner's day around a gap that means
 * something else entirely; offering it lets the person who knows decide.
 */
function suggestedBoundary(edges: Array<{ start: number; end: number }>): number | null {
  if (edges.length < 2) return null;
  let widest = 0;
  let midpoint: number | null = null;
  for (let i = 1; i < edges.length; i += 1) {
    const gap = edges[i].start - edges[i - 1].end;
    if (gap > widest) {
      widest = gap;
      midpoint = Math.round((edges[i - 1].end + edges[i].start) / 2);
    }
  }
  return widest > 0 ? midpoint : null;
}

/**
 * The period a range belongs to, or null when it belongs to neither.
 *
 * A candidate's BUFFER-EXPANDED range must fit WHOLLY inside one period. A straddler is neutral:
 * never scored against both periods, and never assigned to whichever one it mostly occupies.
 * "Mostly" is the tempting rule and it is wrong - a job overlapping lunch is not a morning job,
 * and preferring it as one would cluster an owner's morning around a booking that runs into their
 * afternoon.
 *
 * The boundary belongs to the afternoon: a range starting exactly on it is an afternoon range, and
 * a range ending exactly on it is a morning one. Stated because half-open at both ends would leave
 * an instant in neither period, and closed at both would put it in two.
 */
export function periodOf(range: { start: Date; end: Date }, periods: DayPeriods): HalfDayPeriod | null {
  const { boundary } = periods;
  if (range.end <= boundary) return 'morning';
  if (range.start >= boundary) return 'afternoon';
  return null;
}
