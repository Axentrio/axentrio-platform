import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SV — per-Service customer reschedule / cancel policy, and change-request rows.
 *
 * Existing Services default to `auto` with no extra cutoff, which is today's
 * behaviour. `until_min` 0 is a real cutoff (until the start instant); NULL
 * means no extra cutoff.
 *
 * Change requests are Booking rows (`request_kind` reschedule/cancel) pointing
 * at the original via `related_booking_id`. Accepting one mutates the original
 * and closes the request row; it does not confirm the request row itself.
 */
export class AddCustomerChangePolicy1793900000000 implements MigrationInterface {
  name = 'AddCustomerChangePolicy1793900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ADD COLUMN IF NOT EXISTS "reschedule_mode" varchar(16) NOT NULL DEFAULT 'auto',
        ADD COLUMN IF NOT EXISTS "cancel_mode" varchar(16) NOT NULL DEFAULT 'auto',
        ADD COLUMN IF NOT EXISTS "reschedule_until_min" int,
        ADD COLUMN IF NOT EXISTS "cancel_until_min" int
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_bookings"
        ADD COLUMN IF NOT EXISTS "related_booking_id" uuid,
        ADD COLUMN IF NOT EXISTS "request_kind" varchar(16) NOT NULL DEFAULT 'new',
        ADD COLUMN IF NOT EXISTS "request_resolution" varchar(16)
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_bookings_related_booking'
        ) THEN
          ALTER TABLE "chatbot_bookings"
            ADD CONSTRAINT "fk_bookings_related_booking"
            FOREIGN KEY ("related_booking_id")
            REFERENCES "chatbot_bookings"("id")
            ON DELETE CASCADE;
        END IF;
      END $$
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_chatbot_bookings_change_request'
        ) THEN
          ALTER TABLE "chatbot_bookings"
            ADD CONSTRAINT "chk_chatbot_bookings_change_request"
            CHECK (
              ("request_kind" = 'new' AND "related_booking_id" IS NULL)
              OR ("request_kind" IN ('reschedule', 'cancel') AND "related_booking_id" IS NOT NULL)
            );
        END IF;
      END $$
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_open_change_request"
        ON "chatbot_bookings" ("related_booking_id")
        WHERE "status" = 'request_created'
          AND "request_kind" IN ('reschedule', 'cancel')
          AND "related_booking_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_open_change_request"`);
    await queryRunner.query(`
      ALTER TABLE "chatbot_bookings"
        DROP CONSTRAINT IF EXISTS "chk_chatbot_bookings_change_request",
        DROP CONSTRAINT IF EXISTS "fk_bookings_related_booking"
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_bookings"
        DROP COLUMN IF EXISTS "request_resolution",
        DROP COLUMN IF EXISTS "request_kind",
        DROP COLUMN IF EXISTS "related_booking_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        DROP COLUMN IF EXISTS "cancel_until_min",
        DROP COLUMN IF EXISTS "reschedule_until_min",
        DROP COLUMN IF EXISTS "cancel_mode",
        DROP COLUMN IF EXISTS "reschedule_mode"
    `);
  }
}
