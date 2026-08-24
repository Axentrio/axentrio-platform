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
