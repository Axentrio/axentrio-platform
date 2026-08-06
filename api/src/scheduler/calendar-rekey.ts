/**
 * Calendar conflict-key rekeying (issue: scheduler external-readiness).
 *
 * The booking exclusion constraint (`excl_chatbot_bookings_slot`) only blocks
 * overlaps that share the SAME `calendar_key`. To make it protect across bots
 * that book the same real Google calendar, every booking's key is normalized to
 * the connected calendar's account-unique identity. When a bot's identity changes
 * (connect / reconnect / picker / disconnect) its active future bookings must be
 * rekeyed so the constraint keeps working uniformly.
 */
import { AppDataSource } from '../database/data-source';
import { Booking } from '../database/entities/Booking';
import { logger } from '../utils/logger';

/**
 * Normalized conflict key from a resolved calendar identity (or null → bot-scoped).
 * The prefix is provider-scoped so the same identity string under different
 * providers can never collide: `gcal:<identity>` (Google), `mscal:<account_id>`
 * (Microsoft), or `bot:<botId>` when there is no resolved identity.
 */
export function conflictKeyFor(
  botId: string,
  identity: string | null,
  provider: 'google' | 'microsoft' = 'google'
): string {
  if (!identity) return `bot:${botId}`;
  return `${provider === 'microsoft' ? 'mscal' : 'gcal'}:${identity}`;
}

/**
 * Rekey a bot's active, future bookings to `newKey`. Best-effort per row: a row
 * whose rewrite would violate the slot-exclusion constraint (a pre-existing
 * overlap between bots now resolving to the same calendar) is LEFT on its old key
 * and logged as a `CALENDAR_REKEY_CONFLICT` for manual resolution — never failing
 * the whole rekey or silently merging/dropping. Such overlaps are real prior
 * double-bookings being surfaced, not created here.
 */
export async function rekeyBotBookings(botId: string, newKey: string): Promise<void> {
  // BEFORE the no-rows early return below: a bot's diary identity can move onto another
  // bot's key with no future bookings to carry across, and that state is exactly as
  // hazardous for travel time as one with a full diary. Lazily imported to keep the
  // dependency one-directional — `itinerary-key` reads `conflictKeyFor` from this module.
  // Wrapped because this is observability and the rekey is not: a booking must never be
  // left on a stale key because a warning could not be produced.
  try {
    const { warnIfTravelItineraryNowShared } = await import('../booking/travel/travel-eligibility');
    await warnIfTravelItineraryNowShared(botId, newKey);
  } catch (err) {
    logger.warn('[Booking] travel shared-itinerary re-check unavailable during rekey', { botId, err });
  }

  const repo = AppDataSource.getRepository(Booking);
  const rows: Array<{ id: string; calendar_key: string }> = await repo.query(
    `SELECT id, calendar_key FROM chatbot_bookings
      WHERE bot_id = $1 AND status IN ('pending','confirmed')
        AND upper(blocked_range) > now() AND calendar_key <> $2`,
    [botId, newKey]
  );
  if (!rows.length) return;
  let moved = 0;
  let conflicts = 0;
  for (const r of rows) {
    try {
      await repo.query(`UPDATE chatbot_bookings SET calendar_key = $1, updated_at = now() WHERE id = $2`, [newKey, r.id]);
      moved++;
    } catch (err) {
      if ((err as { code?: string })?.code === '23P01') {
        conflicts++;
        logger.warn('[Booking] CALENDAR_REKEY_CONFLICT — booking left on old key for manual resolution', {
          bookingId: r.id,
          botId,
          oldKey: r.calendar_key,
          newKey,
        });
      } else {
        throw err;
      }
    }
  }
  logger.info('[Booking] calendar rekey complete', { botId, newKey, moved, conflicts, total: rows.length });
}
