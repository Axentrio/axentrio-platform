/**
 * Booking date-window helpers. All timezone work anchors to the BUSINESS
 * timezone, never the server's.
 */
import { DateTime } from 'luxon';
import { BookingError } from './types';

/**
 * Coerce a possibly-loose date range into a UTC [start, end) window. The LLM
 * usually passes date-only strings ("2026-06-08", sometimes start === end); a
 * date-only value is anchored to the BUSINESS timezone's calendar day — NOT UTC
 * (`new Date("2026-06-08")` is UTC midnight, which offsets the window by the
 * zone's UTC offset and makes the slot engine clip real evening slots in
 * negative-offset zones / leak next-day slots in positive-offset zones, drifting
 * with DST). A date-only end includes that whole local day; a zero/negative
 * window becomes a single day. Datetime strings with an explicit offset/Z keep
 * their instant; zoneless datetimes are read as business-local. Output is RFC3339
 * UTC (Google events.list 400s on date-only values).
 */
export function normalizeDateRange(
  startDate: string,
  endDate: string,
  timezone: string,
): { rangeStart: string; rangeEnd: string } {
  const start = DateTime.fromISO(startDate, { zone: timezone });
  if (!start.isValid) {
    throw new BookingError('Invalid start date', 'INVALID_RANGE', 400);
  }
  const endDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(endDate);
  let end = DateTime.fromISO(endDate, { zone: timezone });
  if (endDateOnly && end.isValid) end = end.plus({ days: 1 }); // include the whole end day (local)
  if (!end.isValid || end <= start) end = start.plus({ days: 1 });
  return { rangeStart: start.toUTC().toISO()!, rangeEnd: end.toUTC().toISO()! };
}

/**
 * Parse an appointment time string into a UTC instant, anchored to the business
 * timezone. A string carrying an explicit offset/Z (e.g. a slot returned by
 * check_availability) keeps its instant; a ZONELESS string (e.g.
 * "2026-06-19T14:00:00" — what the model emits for the customer's "2 PM") is read
 * as business-local wall-clock. Without this, a zoneless/UTC time round-trips
 * through `new Date()` on a UTC server as UTC, landing the booking at the wrong
 * local hour in any non-UTC zone. A loose space-separated form ("2026-06-19
 * 14:00") is also anchored to the business timezone via fromSQL — NEVER the
 * server's, which `new Date()` would do (re-introducing the wrong-hour bug).
 * Returns null when unparseable. Same rule as {@link normalizeDateRange}.
 */
export function parseBookingStart(input: string, timezone: string): Date | null {
  const iso = DateTime.fromISO(input, { zone: timezone });
  if (iso.isValid) return iso.toJSDate();
  // Loose "YYYY-MM-DD HH:mm[:ss]" (space, not 'T') — still business-local.
  const sql = DateTime.fromSQL(input, { zone: timezone });
  if (sql.isValid) return sql.toJSDate();
  return null;
}

/**
 * #6: server-format the booking time in the BUSINESS timezone, so the AI can quote
 * it verbatim instead of re-deriving a local time from the UTC instant (which drifts).
 * e.g. "Monday, 23 June 2026 at 12:00 PM".
 */
export function formatBookingDisplayTime(startUtc: Date, timezone: string): string {
  return DateTime.fromJSDate(startUtc).setZone(timezone).toFormat("cccc, d LLLL yyyy 'at' h:mm a");
}

/** Calendar day only - the format `check_availability` takes for startDate/endDate. */
const DAY = 'yyyy-MM-dd';

/**
 * The range to check INSTEAD of one the notice or horizon ruled out, named concretely.
 *
 * BOTH REFUSAL PATHS USE THIS, and they must not disagree. `check_availability` returns an empty
 * range with a reason; `requestAppointment` refuses a capture outright. A customer who meets one
 * and then the other must be sent to the same place.
 *
 * Naming both ends is the point. "Try the days after it" is an instruction a model satisfies by
 * re-checking the same day and reading the same emptiness back. Worse, with no date at all the
 * model invents one: on production a min-notice refusal produced "choose a date after Wednesday
 * 2 September" when the earliest bookable was 25 September, because the refusal it was given
 * carried no boundary. Every date the customer could then pick for three weeks was refused again.
 *
 * A week, in the direction that actually holds the times: forward from the earliest a booking may
 * start, backward from the last date the business accepts. Seven days is already what `endDate`
 * documents as the widest a single check may span.
 */
export function retryRange(
  reason: 'too_soon' | 'too_far' | 'service_day_full',
  boundary: string,
  timezone: string,
): { startDate: string; endDate: string } {
  const at = DateTime.fromISO(boundary, { zone: 'utc' }).setZone(timezone);
  // Unparseable can only be a fixture: keep the date rather than lose the correction.
  if (!at.isValid) return { startDate: boundary.slice(0, 10), endDate: boundary.slice(0, 10) };
  if (reason === 'too_far') {
    // Backward, but never into the past: a short horizon can leave the bound less than a week off.
    const from = DateTime.max(at.minus({ days: 6 }), DateTime.now().setZone(timezone));
    return { startDate: from.toFormat(DAY), endDate: at.toFormat(DAY) };
  }
  // too_soon and service_day_full: a week forward from the bound (earliest start, or the
  // day after the capped-out one).
  return { startDate: at.toFormat(DAY), endDate: at.plus({ days: 6 }).toFormat(DAY) };
}
