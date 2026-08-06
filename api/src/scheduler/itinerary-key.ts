/**
 * The **itinerary key** — whose day a booking sits in (ADR-0016).
 *
 * Travel feasibility is a claim about one person's day: given where they finish, can
 * they reach where they must start next? Nothing in the schema models a person, so
 * today one Agent is one diary is one implicit driver. This key is the seam: every
 * path that will enforce travel takes it as a value, so a second person on the road
 * later arrives as extra rows rather than as a schema change to everything travel
 * touches.
 *
 * It is currently EQUAL to the calendar conflict key, and derived from it rather than
 * computed a second way. `conflictKeyFor` already normalizes to the connected
 * calendar's account-unique identity, so two bots pointed at one real calendar share a
 * key — which is exactly the diary-scoped answer travel needs, and the same value the
 * advisory lock, `loadBusy` and the Minimum Gap check already use. The stored column
 * stays `calendar_key`: this names what that column means to travel, it is not a
 * second source of truth.
 *
 * **Nothing may be stored against the key.** `rekeyBotBookings` rewrites it whenever a
 * calendar is connected, switched or disconnected, so anything hung off it is orphaned
 * by an ordinary settings change. The key scopes *enforcement*; the bot owns
 * *configuration*, which stays on `BookingSettings`.
 */
import { conflictKeyFor } from './calendar-rekey';
import { resolveStoredCalendarIdentity } from './calendar-provider';

/**
 * A diary's identity. A plain string today — the alias is what call sites name, so the
 * concept is visible in a signature instead of being inferred from a variable name.
 */
export type ItineraryKey = string;

/**
 * The itinerary key for a bot's diary.
 *
 * The one function that changes when a driver becomes a first-class thing, which is the
 * whole point of the seam: availability, create, accept and reschedule receive the key,
 * so a second driver is a different resolution here rather than an edit at each of them.
 *
 * Reads the DB-stored identity rather than calling the provider, so the key holds even
 * when calendar sync is entitlement-disabled — existing conflict records must never
 * silently weaken to a bot-scoped key. Falls back to `bot:<id>` when the identity is
 * unknown (no connection, or a legacy one) — never `gcal:primary`, which would collide
 * globally.
 */
export async function resolveItineraryKey(botId: string): Promise<ItineraryKey> {
  const stored = await resolveStoredCalendarIdentity(botId);
  if (!stored) return conflictKeyFor(botId, null);
  return conflictKeyFor(botId, stored.identity, stored.providerType);
}
