import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SV — a personal Microsoft account cannot host Teams for Business, so a video booking on it
 * gets no join link. Persist whether the connected account can host online meetings so the
 * portal can warn the owner. Existing rows default to true (Google + work/school Microsoft).
 */
export class AddCalendarSupportsOnlineMeetings1794200000000 implements MigrationInterface {
  name = 'AddCalendarSupportsOnlineMeetings1794200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_calendar_credentials"
        ADD COLUMN IF NOT EXISTS "supports_online_meetings" boolean NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_calendar_credentials"
        DROP COLUMN IF EXISTS "supports_online_meetings"
    `);
  }
}
