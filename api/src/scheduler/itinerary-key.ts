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
 * It currently EQUALS the value the `calendar_key` column stores, and is produced by
 * calling `conflictKeyFor` rather than by deriving the key a second way. That function
 * already normalizes to the connected calendar's account-unique identity, so two bots
 * pointed at one real calendar share a key - which is exactly the diary-scoped answer
 * travel needs, and the same value the advisory lock, `loadBusy` and the Minimum Gap
 * check already use. The column keeps its name: this names what it MEANS to travel, and
 * is not a second source of truth.
 *
 * **Nothing may be stored against the key.** `rekeyBotBookings` rewrites it whenever a
 * calendar is connected, switched or disconnected, so anything hung off it is orphaned
 * by an ordinary settings change. The key scopes *enforcement*; the bot owns
 * *configuration*, which stays on `BookingSettings`.
 */
import { conflictKeyFor } from './calendar-rekey';
import { resolveStoredCalendarIdentity } from './calendar-provider';
import { AppDataSource } from '../database/data-source';

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
 * when calendar sync is entitlement-disabled - the key already written on existing
 * Bookings must never silently weaken to a bot-scoped one. Falls back to `bot:<id>` when the identity is
 * unknown (no connection, or a legacy one) — never `gcal:primary`, which would collide
 * globally.
 */
export async function resolveItineraryKey(botId: string): Promise<ItineraryKey> {
  const stored = await resolveStoredCalendarIdentity(botId);
  if (!stored) return conflictKeyFor(botId, null);
  return conflictKeyFor(botId, stored.identity, stored.providerType);
}

/**
 * Does another Agent's diary resolve to this same key?
 *
 * This is the multi-driver case arriving early by accident, and it is the one state in
 * which travel enforcement makes a business WORSE OFF than not having it: two people's
 * bookings read as one itinerary, so the gate strips slots for journeys neither of them
 * makes. The travel toggle refuses to enable here, and the runtime gate stays inert while
 * it holds — connecting a calendar can create this state long after travel was legitimately
 * switched on.
 *
 * A `bot:` key is PROVABLY unique: it embeds the bot's own id, so no other bot can produce
 * it. That is a real short-circuit, not an optimisation — a business with no connected
 * calendar answers without touching the database at all.
 *
 * Siblings are resolved through `resolveItineraryKey` rather than by re-deriving a key
 * from their credential rows. Reading `calendarId`/`accountEmail`/`accountId` here would
 * be a second implementation of the derivation, and the day the two disagree this check
 * silently stops firing. The candidate list is narrowed to bots that HAVE an active
 * credential for the same reason the fast path works: a bot without one resolves to `bot:`
 * and cannot match a key that isn't. Plan limits cap a tenant at three bots, so this is at
 * most two extra resolutions.
 */
export async function itineraryKeyIsShared(
  tenantId: string,
  botId: string,
  key: ItineraryKey
): Promise<boolean> {
  if (key.startsWith('bot:')) return false;

  const siblings: Array<{ id: string }> = await AppDataSource.query(
    `SELECT b.id
       FROM chatbot_bots b
       JOIN chatbot_calendar_credentials c ON c.bot_id = b.id AND c.status = 'active'
      WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND b.id <> $2`,
    [tenantId, botId]
  );

  for (const sibling of siblings) {
    if ((await resolveItineraryKey(sibling.id)) === key) return true;
  }
  return false;
}
