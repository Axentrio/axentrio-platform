import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Route-optimization MVP: Auto Optimize only, Maximum Travel Time as a drive
 * ceiling, and the Minimum Gap as the only safety margin (ADR-0019).
 */
export class RouteOptimizationMvp1794700000000 implements MigrationInterface {
  name = 'RouteOptimizationMvp1794700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP CONSTRAINT IF EXISTS "ck_booking_settings_route_priority"
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP COLUMN IF EXISTS "travel_route_priority"
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        RENAME COLUMN "travel_max_detour_min" TO "travel_max_travel_min"
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP COLUMN IF EXISTS "travel_slack_min"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD COLUMN IF NOT EXISTS "travel_slack_min" int
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        RENAME COLUMN "travel_max_travel_min" TO "travel_max_detour_min"
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD COLUMN IF NOT EXISTS "travel_route_priority" text NOT NULL DEFAULT 'auto'
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        ADD CONSTRAINT "ck_booking_settings_route_priority"
        CHECK ("travel_route_priority" IN ('auto', 'nearest', 'farthest'))
    `);
  }
}
