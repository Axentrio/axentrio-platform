/**
 * The `blocked_range` column and its exclusion constraint, in ONE place.
 *
 * `chatbot_bookings.blocked_range` is a `tstzrange` written through raw SQL at every
 * write, and the `Booking` entity deliberately does not map it - nothing in TypeORM
 * needs to read or write a range type, and mapping it would invite `repo.save()` to
 * start doing so. The cost is that `synchronize()`, which is how the integration test
 * schema is built, never creates it.
 *
 * That cost was real and it hid a whole function. `rekeyBotBookings` selects the
 * bookings to move with `upper(blocked_range) > now()`; without the column the SELECT
 * raises `column "blocked_range" ... does not exist`, and every caller wraps the rekey
 * in a `.catch()` because a failed rekey is deliberately non-fatal. So the rekey did
 * nothing in every test in this repository, and any test that appeared to exercise it
 * was passing against a function that never ran (#88).
 *
 * The EXCLUSION CONSTRAINT comes with it, and is not optional garnish: it is what makes
 * two bookings unable to overlap on one itinerary, and the `23P01` it raises is a branch
 * `rekeyBotBookings` handles by leaving a booking on its old key. Without the constraint
 * that branch is unreachable under test, which is the same defect one level down.
 *
 * Both `1784400000000-CreateInternalSchedulerBookings.ts` and `src/__tests__/setup.ts`
 * express this shape. The statements here are written to be idempotent so the test
 * harness can apply them after `synchronize()` against a table the migration may have
 * already built.
 */

/**
 * Bring a synchronize()-built `chatbot_bookings` up to the migration's shape.
 *
 * NULLABLE, where the migration has `NOT NULL`. The migration creates the table with
 * the column present, so every insert supplies it; here the column arrives after test
 * factories already exist, and `NOT NULL` would break every one of them that has no
 * reason to care about a range. A test that needs the range writes it explicitly - and
 * `upper(NULL) > now()` is NULL, so a booking without one is simply not selected, which
 * is the same answer as a booking in the past.
 */
export const INSTALL_BOOKING_BLOCKED_RANGE: readonly string[] = [
  // btree_gist is what lets a `=` on text sit beside a `&&` on a range in one index.
  `CREATE EXTENSION IF NOT EXISTS btree_gist`,
  `ALTER TABLE "chatbot_bookings" ADD COLUMN IF NOT EXISTS "blocked_range" tstzrange`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'excl_chatbot_bookings_slot'
     ) THEN
       ALTER TABLE "chatbot_bookings"
         ADD CONSTRAINT "excl_chatbot_bookings_slot"
         EXCLUDE USING gist ("calendar_key" WITH =, "blocked_range" WITH &&)
         WHERE ("status" IN ('pending', 'confirmed'));
     END IF;
   END $$`,
];
