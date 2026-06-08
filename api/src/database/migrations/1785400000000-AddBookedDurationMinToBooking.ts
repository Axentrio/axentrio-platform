import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P5c — freeze each booking's effective length.
 *
 * Additive, nullable int. Every P5c-era create writes it (including `fixed`
 * services, which write `service.durationMin`), so a non-null value is the
 * booking's frozen length and `null` means only "row predates P5c". No backfill —
 * legacy rows stay null and every consumer falls back to `service.durationMin`.
 */
export class AddBookedDurationMinToBooking1785400000000 implements MigrationInterface {
  name = 'AddBookedDurationMinToBooking1785400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_bookings
        ADD COLUMN IF NOT EXISTS booked_duration_min integer
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_bookings
        DROP COLUMN IF EXISTS booked_duration_min
    `);
  }
}
