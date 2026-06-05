import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Internal scheduler — booking references (Phase 1, slice #10).
 *
 * Links an internal booking to the external (Google) calendar event it was
 * mirrored to, so reschedule/cancel can update/delete the right event.
 */
export class CreateBookingReferences1784600000000 implements MigrationInterface {
  name = 'CreateBookingReferences1784600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_booking_references" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "booking_id" uuid NOT NULL,
        "provider_type" varchar(16) NOT NULL DEFAULT 'google',
        "external_event_id" varchar(1024) NOT NULL,
        "external_calendar_id" varchar(320) NOT NULL,
        "meeting_url" varchar(1024) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chatbot_booking_references" PRIMARY KEY ("id"),
        CONSTRAINT "fk_chatbot_booking_references_booking"
          FOREIGN KEY ("booking_id") REFERENCES "chatbot_bookings"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_booking_references_booking_provider"
        ON "chatbot_booking_references" ("booking_id", "provider_type")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_booking_references"`);
  }
}
