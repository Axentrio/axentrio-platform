import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A "stop taking new bookings" switch.
 *
 * Until now an owner who was ill, away or simply full had to delete their weekly hours and
 * rebuild them from memory afterwards, or pause the whole bot — which also silences it for
 * every question that has nothing to do with booking.
 *
 * NOT NULL DEFAULT false, so every existing row means exactly what it meant yesterday.
 */
export class AddBookingsPaused1789100000000 implements MigrationInterface {
  name = 'AddBookingsPaused1789100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_booking_settings
        ADD COLUMN IF NOT EXISTS bookings_paused boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_booking_settings DROP COLUMN IF EXISTS bookings_paused
    `);
  }
}
