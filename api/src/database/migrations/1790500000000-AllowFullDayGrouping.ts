import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `full_day` becomes a value the column will accept, now that the engine can produce it.
 *
 * The previous migration deliberately excluded it. `insertion-scorer` bucketed anchors per HALF
 * day and had no way to compare a candidate against a whole one, so a stored `full_day` would
 * have been read as no grouping at all - the owner picks an option, nothing changes, and they
 * conclude the feature is broken rather than unbuilt.
 *
 * The scorer now takes `groupWholeDay` and prices a candidate against every job of the local day,
 * so the constraint can widen. This is the deliberate second half of a two-step: the option and
 * its behaviour ship together, and the constraint is what made that impossible to forget.
 *
 * `down` narrows the CHECK again, and first rewrites any `full_day` row to `half_day` rather than
 * leaving a row the constraint would reject. Half day is the honest fallback: it is still
 * grouping, just over a shorter stretch, so an owner who had asked for grouping keeps getting it.
 */
export class AllowFullDayGrouping1790500000000 implements MigrationInterface {
  name = 'AllowFullDayGrouping1790500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP CONSTRAINT IF EXISTS "ck_booking_settings_grouping_period"
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD CONSTRAINT "ck_booking_settings_grouping_period"
        CHECK ("travel_grouping_period" IN ('none', 'half_day', 'full_day'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rows first, or the narrowed constraint cannot be added at all.
    await queryRunner.query(`
      UPDATE "chatbot_booking_settings"
         SET "travel_grouping_period" = 'half_day'
       WHERE "travel_grouping_period" = 'full_day'
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP CONSTRAINT IF EXISTS "ck_booking_settings_grouping_period"
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD CONSTRAINT "ck_booking_settings_grouping_period"
        CHECK ("travel_grouping_period" IN ('none', 'half_day'))
    `);
  }
}
