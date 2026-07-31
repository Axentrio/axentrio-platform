import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index `chatbot_bookings.lead_id`.
 *
 * Migration 1787500000000 added the column; the leads list then queries it TWICE per
 * row — once in the LATERAL that derives the shown booking, once in the `booking_count`
 * subquery. Without an index Postgres uses the existing `tenant_id` index and FILTERS on
 * `lead_id`, so a 25-row page evaluates that filter across the tenant's entire booking
 * history ~50 times. Verified with EXPLAIN:
 *
 *   Index Scan using IDX_…(tenant_id) on chatbot_bookings b
 *     Index Cond: (tenant_id = …)
 *     Filter: (lead_id = …)      ← the part this migration removes
 *
 * Partial on NOT NULL: every booking that predates the column has `lead_id IS NULL`, and
 * those rows can never satisfy the query, so keeping them out of the index costs nothing
 * and keeps it small.
 *
 * NOT `CONCURRENTLY`, deliberately: TypeORM runs each migration inside a transaction and
 * `CREATE INDEX CONCURRENTLY` cannot run in one. Turning transaction mode off globally to
 * accommodate one index would remove the atomicity every other migration relies on. A
 * plain build takes a brief SHARE lock (blocking writes, not reads) on a table that holds
 * thousands of rows at SMB scale — milliseconds. If `chatbot_bookings` ever grows past
 * ~1M rows, build this index by hand with CONCURRENTLY BEFORE deploying, and this
 * migration becomes an idempotent no-op.
 *
 * (Migration 1787500000000's header claimed this would use CONCURRENTLY — that comment
 * has been corrected, since it described a plan the runner cannot execute.)
 */
export class AddBookingLeadIndex1787800000000 implements MigrationInterface {
  name = 'AddBookingLeadIndex1787800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_bookings_lead"
        ON "chatbot_bookings" ("lead_id")
        WHERE "lead_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_bookings_lead"`);
  }
}
