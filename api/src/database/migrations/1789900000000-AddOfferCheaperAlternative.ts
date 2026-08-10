import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #81 (LP4) - whether steering had anywhere better to point.
 *
 * The fourth question `AddOfferRankingColumns` set out to answer and did not give a column to:
 * "how often is a cheaper alternative even available". It is the phase's most decision-shaped
 * number, because if the answer is "rarely" then the pilot cannot move any metric whatever it
 * does, and the epic ends here having cost one ticket rather than a live feature.
 *
 * STORED rather than derived, and the reason is a property of the row it sits on. It is a
 * statement about every slot the scorer saw, while `offered_slots` deliberately keeps only the
 * ones the channel actually delivered - so recomputing it later from this row would quietly
 * answer a narrower question and report a smaller number.
 *
 * Nullable, like the rest: an offer made while grouping did not run carries no scoring at all,
 * and `false` would claim the scorer looked and found nothing.
 */
export class AddOfferCheaperAlternative1789900000000 implements MigrationInterface {
  name = 'AddOfferCheaperAlternative1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_offers"
        ADD COLUMN IF NOT EXISTS "cheaper_alternative_existed" boolean
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_offers"
        DROP COLUMN IF EXISTS "cheaper_alternative_existed"
    `);
  }
}
