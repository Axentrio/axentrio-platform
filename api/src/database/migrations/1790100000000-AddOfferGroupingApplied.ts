import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #82 (LP5) - which offers were actually reordered, and by how much.
 *
 * The pilot's first settled decision is that BOTH parties are told. The customer's half is a
 * sentence in the conversation. The owner's half was a server log line, which is not something an
 * owner can be shown and not something a query can count - so "we told them" was true only in the
 * sense that it appeared in an operator's console.
 *
 * It also makes the pilot answerable. LP4 records what the scorer WOULD have done; without this
 * there is no way to separate the offers where it actually did from the offers where it did not,
 * and the whole comparison LP5 exists for is between those two populations.
 *
 * Nullable: an offer made while the pilot was off carries no answer, and `false` would claim the
 * scorer looked and declined to reorder.
 */
export class AddOfferGroupingApplied1790100000000 implements MigrationInterface {
  name = 'AddOfferGroupingApplied1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_offers"
        ADD COLUMN IF NOT EXISTS "grouping_applied" boolean,
        ADD COLUMN IF NOT EXISTS "grouping_saved_minutes" integer
    `);
    // The pilot cohort is "offers where the order was actually changed", read over a window, so
    // both dimensions are indexed together. Partial, because most rows will never be reordered.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "ix_booking_offers_grouped"
         ON "chatbot_booking_offers" ("grouping_applied", "created_at")
       WHERE "grouping_applied" IS TRUE`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_booking_offers_grouped"`);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_offers"
        DROP COLUMN IF EXISTS "grouping_saved_minutes",
        DROP COLUMN IF EXISTS "grouping_applied"
    `);
  }
}
