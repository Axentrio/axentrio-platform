import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill `chatbot_bookings.lead_id` for bookings that predate the column.
 *
 * Why this is needed: the Pro lead columns (requested service, address, preferred date,
 * booking status, list price) are DERIVED by joining `chatbot_bookings.lead_id`. That
 * column is only populated by the booking hook going forward, so on the day Story 3
 * shipped every historical lead rendered an empty row of dashes — the headline Pro
 * feature looked broken on real data. Verified on production: 0 of 47 bookings had a
 * lead_id, while 10 were recoverable.
 *
 * The link is recovered through `session_id`, which both tables already carry: a booking
 * made during a conversation belongs to whoever was captured as the lead in that same
 * conversation.
 *
 * AMBIGUITY IS SKIPPED, NOT GUESSED. One session can, in principle, hold more than one
 * lead — a visitor who gives two different email addresses in one chat produces two
 * identity rows. Attaching a booking to an arbitrary one of them would put a real
 * appointment against the wrong person, which is worse than leaving the column blank.
 * The `HAVING count(*) = 1` clause means such sessions are left alone; they simply keep
 * showing dashes, exactly as they did before this migration.
 *
 * Idempotent (`WHERE lead_id IS NULL`) and additive — re-running changes nothing.
 */
export class BackfillBookingLeadIds1788000000000 implements MigrationInterface {
  name = 'BackfillBookingLeadIds1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH unambiguous AS (
        -- (array_agg(id))[1], NOT min(id): Postgres has no min() for uuid, and that
        -- form fails at RUNTIME with "function min(uuid) does not exist" — i.e. it
        -- would crash-loop the API on boot. HAVING count(*) = 1 means the array holds
        -- exactly one element, so taking the first is unambiguous by construction.
        SELECT session_id, tenant_id, (array_agg(id))[1] AS lead_id
          FROM chatbot_leads
         WHERE session_id IS NOT NULL
           AND deleted_at IS NULL
         GROUP BY session_id, tenant_id
        HAVING count(*) = 1
      )
      UPDATE chatbot_bookings b
         SET lead_id = u.lead_id
        FROM unambiguous u
       WHERE b.lead_id IS NULL
         AND b.session_id = u.session_id
         AND b.tenant_id = u.tenant_id
    `);
  }

  /**
   * Clears only what this migration could have set. It cannot distinguish a backfilled
   * link from one the booking hook wrote afterwards, so it is scoped to bookings whose
   * session still resolves to exactly one lead — the same set `up()` touched. Rolling
   * back therefore returns those rows to blank, which is the pre-migration state.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH unambiguous AS (
        SELECT session_id, tenant_id
          FROM chatbot_leads
         WHERE session_id IS NOT NULL AND deleted_at IS NULL
         GROUP BY session_id, tenant_id
        HAVING count(*) = 1
      )
      UPDATE chatbot_bookings b
         SET lead_id = NULL
        FROM unambiguous u
       WHERE b.session_id = u.session_id AND b.tenant_id = u.tenant_id
    `);
  }
}
