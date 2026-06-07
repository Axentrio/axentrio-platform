import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill normalized calendar conflict keys for already-connected bots.
 *
 * Bookings created before the normalized-key change carry `calendar_key =
 * bot:<botId>`. For bots with an active Google credential whose identity is known
 * (a non-`primary` calendarId, or `primary` + a verified account_email), their
 * active FUTURE bookings should key off the real calendar (`gcal:<identity>`) so
 * the slot-exclusion constraint protects across bots sharing one calendar.
 *
 * Per-row loop with exception handling: a row whose rewrite would violate
 * `excl_chatbot_bookings_slot` (a pre-existing cross-bot overlap on the same
 * calendar) is left on its old key and a warning is raised — never failing the
 * whole migration. Idempotent (only rewrites rows whose key differs).
 *
 * NOTE: at ship time existing creds have `account_email = NULL` (it was only
 * captured from this release onward), so primary-calendar bots are skipped here
 * and get rekeyed organically on their next reconnect. This migration mainly
 * covers non-`primary` calendarId creds and is safe to re-run.
 */
export class BackfillNormalizedCalendarKeys1785000000000 implements MigrationInterface {
  name = 'BackfillNormalizedCalendarKeys1785000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN
          SELECT b.id AS booking_id,
                 'gcal:' || (CASE WHEN c.calendar_id <> 'primary' THEN c.calendar_id ELSE c.account_email END) AS new_key
          FROM chatbot_bookings b
          JOIN chatbot_calendar_credentials c
            ON c.bot_id = b.id AND c.provider = 'google' AND c.status = 'active'
          WHERE b.status IN ('pending','confirmed')
            AND upper(b.blocked_range) > now()
            AND (CASE WHEN c.calendar_id <> 'primary' THEN c.calendar_id ELSE c.account_email END) IS NOT NULL
            AND b.calendar_key <> ('gcal:' || (CASE WHEN c.calendar_id <> 'primary' THEN c.calendar_id ELSE c.account_email END))
        LOOP
          BEGIN
            UPDATE chatbot_bookings SET calendar_key = r.new_key, updated_at = now() WHERE id = r.booking_id;
          EXCEPTION WHEN exclusion_violation THEN
            RAISE WARNING 'CALENDAR_REKEY_CONFLICT: booking % left on old key (target %)', r.booking_id, r.new_key;
          END;
        END LOOP;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Irreversible: original per-row keys aren't recorded. No-op.
  }
}
