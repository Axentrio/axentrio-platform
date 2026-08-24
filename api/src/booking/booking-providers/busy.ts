/**
 * Busy-interval loaders for the slot engine: internal bookings, the business
 * day ledger, and the merged view that fails closed on calendar outages.
 */
import { AppDataSource } from '../../database/data-source';
import { Booking } from '../../database/entities/Booking';
import { logger } from '../../utils/logger';
import type { BookingContext } from './types';
import { BookingError } from './types';
import type { BusyInterval } from './slot-engine';
import { loadBusinessRules } from './capacity';
import { resolveCalendarProvider } from '../../scheduler/calendar-provider';
import type { ItineraryKey } from '../../scheduler/itinerary-key';

/**
 * Existing pending/confirmed bookings' blocked ranges overlapping [start,end).
 * `excludeId` omits a booking from the result (used on reschedule so a booking
 * never conflicts with its own current slot).
 */
export async function loadBusy(
  itineraryKey: ItineraryKey,
  rangeStartIso: string,
  rangeEndIso: string,
  excludeId?: string
): Promise<BusyInterval[]> {
  const rows: Array<{ s: string; e: string }> = await AppDataSource.getRepository(Booking).query(
    // `calendar_key` is the stored column; the itinerary key is what it means here.
    `SELECT lower(blocked_range) AS s, upper(blocked_range) AS e
       FROM chatbot_bookings
      WHERE calendar_key = $1 AND status IN ('pending','confirmed')
        AND blocked_range && tstzrange($2, $3, '[)')
        AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [itineraryKey, rangeStartIso, rangeEndIso, excludeId ?? null]
  );
  return rows.map((r) => ({ start: new Date(r.s), end: new Date(r.e) }));
}

/**
 * This bot's HELD bookings at their RAW start/end, for business day totals.
 *
 * Deliberately not derived from `loadAllBusy`: that merges the owner's external calendar
 * events and returns buffer-expanded bounds, so counting it would refuse slots because of
 * a personal appointment and would bill buffers as sold working time.
 */
export async function loadDayLedger(
  botId: string,
  rangeStartIso: string,
  rangeEndIso: string,
  excludeId?: string
): Promise<BusyInterval[]> {
  const rows: Array<{ s: string; e: string }> = await AppDataSource.getRepository(Booking).query(
    `SELECT start_utc AS s, end_utc AS e
       FROM chatbot_bookings
      WHERE bot_id = $1 AND status IN ('pending','confirmed')
        AND start_utc >= $2 AND start_utc < $3
        AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [botId, rangeStartIso, rangeEndIso, excludeId ?? null]
  );
  return rows.map((r) => ({ start: new Date(r.s), end: new Date(r.e) }));
}

/**
 * Internal booking busy + (if the bot has Google connected) the owner's
 * Google calendar busy. Fails closed if Google can't be reached, so we never
 * offer a slot that might collide with a real event.
 */
export async function loadAllBusy(
  ctx: BookingContext,
  itineraryKey: ItineraryKey,
  rangeStartIso: string,
  rangeEndIso: string,
  timezone?: string,
  excludeId?: string,
  excludeExternalInterval?: { start: Date; end: Date }
): Promise<BusyInterval[]> {
  let internal = await loadBusy(itineraryKey, rangeStartIso, rangeEndIso, excludeId);
  // Business minimum gap: pad OUR bookings only. Padding the owner's personal calendar
  // events too would quietly refuse slots around their dentist appointment, which is not
  // what "minimum time between bookings" asks for. Applied on this side ONLY — the engine
  // already expands the candidate by its own buffers, and doing both would double it.
  const { minGapMin } = await loadBusinessRules(ctx.bot.id);
  if (minGapMin > 0) {
    const gapMs = minGapMin * 60_000;
    internal = internal.map((iv) => ({
      start: new Date(iv.start.getTime() - gapMs),
      end: new Date(iv.end.getTime() + gapMs),
    }));
  }
  let external: BusyInterval[] | null = null;
  try {
    const provider = await resolveCalendarProvider(ctx.bot.id);
    // Pass the rule timezone so the provider anchors all-day events to the
    // business's local day rather than UTC midnight.
    external = provider ? await provider.getBusy(ctx.bot.id, rangeStartIso, rangeEndIso, timezone) : null;
  } catch (err) {
    logger.warn('[Booking] external calendar free/busy unavailable — failing closed', {
      botId: ctx.bot.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new BookingError(
      'Calendar is temporarily unavailable, please try again shortly',
      'BOOKING_TEMPORARILY_UNAVAILABLE',
      503
    );
  }
  // On reschedule the booking's OWN mirrored external event sits at its old time;
  // drop it (exact raw start/end match — the mirror carries no buffer) so a nearby
  // move doesn't conflict with itself. excludeId only covers the internal copy.
  if (external && excludeExternalInterval) {
    const xs = excludeExternalInterval.start.getTime();
    const xe = excludeExternalInterval.end.getTime();
    external = external.filter((iv) => !(iv.start.getTime() === xs && iv.end.getTime() === xe));
  }
  return external ? [...internal, ...external] : internal;
}
