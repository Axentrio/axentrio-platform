import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record what the service-area gate SAW on each booking.
 *
 * The gate has only ever been observable through a log line — its own comment said so. A
 * business could therefore turn work away for months and never learn that the area they drew
 * was costing them, which is the opposite of what the settings screen promises ("out-of-area
 * jobs held back for you to confirm").
 *
 * Nullable on purpose, and null is NOT a fourth verdict: it means the gate did not apply —
 * the service asks for no address, or no enforceable place is configured. Every existing row
 * is null, which is exactly right: we do not know what the gate would have said.
 */
export class AddBookingServiceAreaMatch1789200000000 implements MigrationInterface {
  name = 'AddBookingServiceAreaMatch1789200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_bookings
        ADD COLUMN IF NOT EXISTS service_area_match varchar(16)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_bookings DROP COLUMN IF EXISTS service_area_match
    `);
  }
}
