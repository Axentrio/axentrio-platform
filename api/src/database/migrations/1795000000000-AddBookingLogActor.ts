import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Who mutated a Booking. `booking_logs.session_id` is the customer conversation
 * the appointment was created in — owner/inbound cancel reused that session, so
 * portal cancel was indistinguishable from the widget. Actor is a separate fact.
 *
 * Null on existing rows: we cannot reconstruct who cancelled them.
 */
export class AddBookingLogActor1795000000000 implements MigrationInterface {
  name = 'AddBookingLogActor1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "booking_logs"
        ADD COLUMN "actor_kind" character varying(32),
        ADD COLUMN "actor_id" character varying(255)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "booking_logs"
        DROP COLUMN "actor_id",
        DROP COLUMN "actor_kind"
    `);
  }
}
