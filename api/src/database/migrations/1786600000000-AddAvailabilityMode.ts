import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `availability_mode` to `chatbot_availability_rules`.
 *
 * `business_hours` (default) keeps the existing behavior — slots are gated by
 * `weekly_hours`. `always_open` makes the owner bookable 24/7 (calendar busy is
 * the only limit), fixing the "empty weekly hours = never open" footgun for
 * always-on / emergency businesses. Existing rows default to `business_hours`.
 */
export class AddAvailabilityMode1786600000000 implements MigrationInterface {
  name = 'AddAvailabilityMode1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_availability_rules"
      ADD COLUMN IF NOT EXISTS "availability_mode" varchar(16) NOT NULL DEFAULT 'business_hours'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_availability_rules" DROP COLUMN IF EXISTS "availability_mode"
    `);
  }
}
