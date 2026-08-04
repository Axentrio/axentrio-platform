import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Business-level capacity rules on the existing booking-settings row.
 *
 * All three columns are nullable with no default, and null means unlimited — so this
 * migration changes the behaviour of exactly nothing until an owner sets a value. Nothing
 * to backfill: every existing bot keeps the per-service limits it already had.
 */
export class AddBusinessCapacityRules1788600000000 implements MigrationInterface {
  name = 'AddBusinessCapacityRules1788600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD COLUMN IF NOT EXISTS "max_bookings_per_day" int,
        ADD COLUMN IF NOT EXISTS "max_booked_minutes_per_day" int,
        ADD COLUMN IF NOT EXISTS "min_gap_min" int
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP COLUMN IF EXISTS "max_bookings_per_day",
        DROP COLUMN IF EXISTS "max_booked_minutes_per_day",
        DROP COLUMN IF EXISTS "min_gap_min"
    `);
  }
}
