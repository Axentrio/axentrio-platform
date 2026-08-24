/**
 * Business-capacity gates: per-service day caps, business-wide day ceilings,
 * and the race-safe minimum-gap check. All count HELD rows
 * (`status IN ('pending','confirmed')`) so a captured request never consumes
 * capacity. All take the caller's `manager` where a transaction is in flight -
 * dropping it takes a second pool connection under an advisory lock.
 */
import { DateTime } from 'luxon';
import type { EntityManager } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { BookingSettings } from '../../database/entities/BookingSettings';
import { ServiceType } from '../../database/entities/ServiceType';
import { BookingError } from './types';
import type { BusinessRules } from './service-timing';
import type { ItineraryKey } from '../../scheduler/itinerary-key';
import { normalizeVenue } from '../../contracts/venue-address';

/**
 * P5b — enforce `maxBookingsPerDay` for a service on the slot's local calendar day.
 * Counts only HELD rows (`status IN ('pending','confirmed')`) for the same service,
 * by `start_utc` in the half-open `[dayStart, nextDay)` window of `timezone` (Luxon,
 * DST-exact). `null`/`≤0` cap = unlimited (a malformed/legacy row degrades to "no
 * limit", never "no bookings"). Runs inside the caller's advisory-lock transaction so
 * the count-then-write is atomic. `excludeBookingId` skips the row being rescheduled.
 */
export async function enforceServiceDayCapacity(
  manager: EntityManager,
  service: ServiceType,
  start: Date,
  timezone: string,
  excludeBookingId?: string
): Promise<void> {
  const max = service.maxBookingsPerDay;
  if (!max || max <= 0) return; // unlimited
  const local = DateTime.fromJSDate(start).setZone(timezone);
  const dayStart = local.startOf('day').toUTC().toISO();
  // plus THEN startOf: in a zone whose DST transition lands at midnight, adding 24h to the
  // start of the day gives 23:00 or 01:00 of the next day, not its start — so the window
  // clipped or double-counted an hour and the gate disagreed with the ledger.
  const nextDay = local.plus({ days: 1 }).startOf('day').toUTC().toISO();
  const params: unknown[] = [service.id, dayStart, nextDay];
  let sql = `SELECT count(*)::int AS n FROM chatbot_bookings
             WHERE event_type_id = $1 AND status IN ('pending','confirmed')
               AND start_utc >= $2 AND start_utc < $3`;
  if (excludeBookingId) {
    sql += ` AND id <> $4`;
    params.push(excludeBookingId);
  }
  const rows: Array<{ n: number }> = await manager.query(sql, params);
  if ((rows[0]?.n ?? 0) >= max) {
    throw new BookingError('No more openings for this service that day', 'CAPACITY_REACHED', 409);
  }
}

/** Business-level ceilings, normalised so null/negative/0 all read as "unlimited". */
/**
 * `manager` matters when this is called from INSIDE a booking transaction: without it the
 * read takes a SECOND connection from the pool while the first is mid-transaction holding
 * an advisory lock, which is a pool-exhaustion deadlock waiting for load.
 */
export async function loadBusinessRules(botId: string, manager?: EntityManager): Promise<BusinessRules> {
  const row = await (manager ?? AppDataSource.manager).getRepository(BookingSettings).findOne({ where: { botId } });
  const n = (v: number | null | undefined): number => (typeof v === 'number' && v > 0 ? v : 0);
  // Ceilings normalise 0/negative to "unlimited"; DEFAULTS must keep a real 0 (a business
  // that genuinely wants zero notice is saying something different from "unset").
  const d = (v: number | null | undefined): number | null => (typeof v === 'number' ? v : null);
  return {
    maxBookingsPerDay: n(row?.maxBookingsPerDay),
    maxBookedMinutesPerDay: n(row?.maxBookedMinutesPerDay),
    minGapMin: n(row?.minGapMin),
    defaultBufferBeforeMin: d(row?.defaultBufferBeforeMin),
    defaultBufferAfterMin: d(row?.defaultBufferAfterMin),
    defaultMinNoticeMin: d(row?.defaultMinNoticeMin),
    defaultMaxHorizonDays: d(row?.defaultMaxHorizonDays),
    // Absent settings row ⇒ not paused, which is every existing bot's behaviour.
    bookingsPaused: !!row?.bookingsPaused,
    venue: normalizeVenue({
      street: row?.venueStreet,
      postalCode: row?.venuePostalCode,
      city: row?.venueCity,
      country: row?.venueCountry,
    }),
  };
}

/**
 * Business-level capacity, enforced across EVERY service rather than per service.
 *
 * Mirrors `enforceServiceDayCapacity` deliberately — same `manager` (so count-then-write is
 * atomic inside the caller's advisory lock), same half-open local-day window, same
 * `status IN ('pending','confirmed')` so a captured request never consumes capacity, same
 * `excludeBookingId` for reschedule/accept. It differs in scoping to `bot_id` rather than
 * one service, which is the entire point: five services capped at 2/day still allowed ten
 * jobs in a day.
 *
 * The gap check is the race-safe twin of the busy-inflation the slot engine sees. It has to
 * exist separately because the `EXCLUDE USING gist` constraint only understands overlap of
 * `blocked_range` — it cannot see a required gap, so two concurrent bookers would otherwise
 * both pass the pre-lock re-validation and land back to back.
 *
 * THE TWO HALVES SCOPE DIFFERENTLY, deliberately. The day ceilings ask "how much has this
 * BUSINESS sold today", a question about the bot's own catalogue, so they count by `bot_id`.
 * The gap asks "is anything parked too close to this in the DIARY", a question about one
 * person's day — so it scopes to the ITINERARY KEY (ADR-0016), and two bots pointed at one
 * real calendar share one. A bot-scoped gap query could not see the neighbour that the
 * advisory lock and `loadBusy` both already count: it passed, and the two bookings landed
 * back to back on a calendar that had room for only one of them. Scoping the gap to the key
 * also lets it use the `(calendar_key, blocked_range)` exclusion index rather than filtering
 * on `bot_id`. Travel feasibility will land on this same half, for the same reason.
 */
export async function enforceBusinessCapacity(
  manager: EntityManager,
  botId: string,
  itineraryKey: ItineraryKey,
  rules: BusinessRules,
  window: { start: Date; end: Date; blockedStart: Date; blockedEnd: Date },
  timezone: string,
  excludeBookingId?: string
): Promise<void> {
  const { maxBookingsPerDay, maxBookedMinutesPerDay, minGapMin } = rules;
  if (!maxBookingsPerDay && !maxBookedMinutesPerDay && !minGapMin) return;

  if (maxBookingsPerDay || maxBookedMinutesPerDay) {
    const local = DateTime.fromJSDate(window.start).setZone(timezone);
    const dayStart = local.startOf('day').toUTC().toISO();
    // plus THEN startOf: in a zone whose DST transition lands at midnight, adding 24h to the
    // start of the day gives 23:00 or 01:00 of the next day, not its start — so the window
    // clipped or double-counted an hour and the gate disagreed with the ledger.
    const nextDay = local.plus({ days: 1 }).startOf('day').toUTC().toISO();
    const params: unknown[] = [botId, dayStart, nextDay];
    // Minutes come from the stored span, not booked_duration_min — that column is null for
    // legacy rows and for requests, and a null would silently bill the job as zero minutes.
    let sql = `SELECT count(*)::int AS n,
                      COALESCE(SUM(EXTRACT(EPOCH FROM (end_utc - start_utc)) / 60), 0)::int AS mins
                 FROM chatbot_bookings
                WHERE bot_id = $1 AND status IN ('pending','confirmed')
                  AND start_utc >= $2 AND start_utc < $3`;
    if (excludeBookingId) {
      sql += ` AND id <> $4`;
      params.push(excludeBookingId);
    }
    const rows: Array<{ n: number; mins: number }> = await manager.query(sql, params);
    const used = rows[0] ?? { n: 0, mins: 0 };

    if (maxBookingsPerDay && (used.n ?? 0) >= maxBookingsPerDay) {
      throw new BookingError('This business is fully booked that day', 'CAPACITY_REACHED', 409);
    }
    if (maxBookedMinutesPerDay) {
      const newMins = Math.max(0, (window.end.getTime() - window.start.getTime()) / 60_000);
      if ((used.mins ?? 0) + newMins > maxBookedMinutesPerDay) {
        throw new BookingError('This business has no working time left that day', 'CAPACITY_REACHED', 409);
      }
    }
  }

  if (minGapMin) {
    const gapMs = minGapMin * 60_000;
    const params: unknown[] = [
      itineraryKey,
      new Date(window.blockedStart.getTime() - gapMs).toISOString(),
      new Date(window.blockedEnd.getTime() + gapMs).toISOString(),
    ];
    let sql = `SELECT 1 FROM chatbot_bookings
                WHERE calendar_key = $1 AND status IN ('pending','confirmed')
                  AND blocked_range && tstzrange($2, $3, '[)')`;
    if (excludeBookingId) {
      sql += ` AND id <> $4`;
      params.push(excludeBookingId);
    }
    sql += ' LIMIT 1';
    const clash: unknown[] = await manager.query(sql, params);
    if (clash.length) {
      throw new BookingError('That time is too close to another appointment', 'CAPACITY_REACHED', 409);
    }
  }
}
