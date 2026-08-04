import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Freeze the ICS ORGANIZER per booking.
 *
 * Nullable with no default and no backfill ON PURPOSE: existing bookings must keep
 * resolving their organizer the old way, because their invite has already gone out with
 * that address and a calendar client matches the update/cancel against it. Backfilling a
 * different value here would break exactly the chain this column exists to protect.
 */
export class AddBookingOrganizerEmail1788700000000 implements MigrationInterface {
  name = 'AddBookingOrganizerEmail1788700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chatbot_bookings" ADD COLUMN IF NOT EXISTS "organizer_email" varchar(320)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chatbot_bookings" DROP COLUMN IF EXISTS "organizer_email"`);
  }
}
