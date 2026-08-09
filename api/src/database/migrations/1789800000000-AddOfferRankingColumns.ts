import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #81 (LP4) - somewhere to put what the scorer thought.
 *
 * LP3's offer record stores what was OFFERED. This adds what the scorer would have PREFERRED,
 * without changing what anybody was shown. The whole phase turns on being able to answer four
 * questions later, and none of them can be answered from what is stored today:
 *
 *   - what do the scores look like (per-slot cost, on the slot it belongs to)
 *   - is the ranking stable and deterministic (the counterfactual order, plus the scorer version
 *     that produced it - two versions disagreeing is not instability, and conflating them would
 *     make the gate unfalsifiable)
 *   - what does it cost in elements and latency
 *   - how often is a cheaper alternative even available, which decides whether steering is worth
 *     doing at all
 *
 * The per-slot fields go INSIDE `offered_slots` rather than into a parallel array, because the
 * pairing between a slot and its score is the thing that must not drift. A second array indexed
 * by position is one truncation away from attributing a cost to the wrong time.
 *
 * All nullable: an offer made while grouping did not run - no travel entitlement, no anchors, a
 * spent budget - carries no scoring at all, and that absence is itself data.
 */
export class AddOfferRankingColumns1789800000000 implements MigrationInterface {
  name = 'AddOfferRankingColumns1789800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_offers"
        ADD COLUMN IF NOT EXISTS "scorer_version" varchar(32),
        ADD COLUMN IF NOT EXISTS "scoring_elements" integer,
        ADD COLUMN IF NOT EXISTS "scoring_ms" integer,
        ADD COLUMN IF NOT EXISTS "counterfactual_order" jsonb
    `);
    // The gate reads these per scorer version over a window, so both dimensions are indexed
    // together. Partial, because most rows will never have been scored.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "ix_booking_offers_scored"
         ON "chatbot_booking_offers" ("scorer_version", "created_at")
       WHERE "scorer_version" IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_booking_offers_scored"`);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_offers"
        DROP COLUMN IF EXISTS "counterfactual_order",
        DROP COLUMN IF EXISTS "scoring_ms",
        DROP COLUMN IF EXISTS "scoring_elements",
        DROP COLUMN IF EXISTS "scorer_version"
    `);
    // The per-slot fields inside `offered_slots` are left alone: they are extra keys on a jsonb
    // document nothing reads unless it is looking for them, and stripping them would rewrite
    // every row to undo something harmless.
  }
}
