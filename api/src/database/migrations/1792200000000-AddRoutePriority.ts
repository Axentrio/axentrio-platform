import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Route Priority — a presentation-only sort of the Slot list grouping already scored.
 *
 * ADR-0017 (2026-08-17): the selector chooses the sort key and never membership. Default `auto`
 * is the grouping scorer's existing preference, so existing rows keep today's behaviour.
 *
 * TEXT + CHECK rather than a Postgres enum, matching `travel_grouping_period`: the list is
 * expected to stay small, and a CHECK is edited by any later migration without ceremony.
 */
export class AddRoutePriority1792200000000 implements MigrationInterface {
  name = 'AddRoutePriority1792200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP CONSTRAINT IF EXISTS "ck_booking_settings_route_priority"
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_booking_settings"
        DROP COLUMN IF EXISTS "travel_route_priority"
    `);
  }
}
