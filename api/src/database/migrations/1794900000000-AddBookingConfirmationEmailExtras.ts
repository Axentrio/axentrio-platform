import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Global extras for the CUSTOMER booking-confirmation email: one owner-authored
 * information text and a durable list of attachments that ride every confirmation.
 *
 * Per Agent, not per Service: the venue and the travel switches already live on this
 * row, and an owner who writes "arrive 10 minutes early" means it for every service
 * that Agent books.
 *
 * The attachment list holds METADATA only. The bytes live under the durable
 * `booking-confirmation/` S3 prefix, deliberately outside the 30-day chat
 * `UploadSession` storage the GDPR cleanup scheduler prunes.
 */
export class AddBookingConfirmationEmailExtras1794900000000 implements MigrationInterface {
  name = 'AddBookingConfirmationEmailExtras1794900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chatbot_booking_settings"
         ADD COLUMN IF NOT EXISTS "confirmation_extra_info" text NULL,
         ADD COLUMN IF NOT EXISTS "confirmation_attachments" jsonb NOT NULL DEFAULT '[]'::jsonb`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chatbot_booking_settings"
         DROP COLUMN IF EXISTS "confirmation_extra_info",
         DROP COLUMN IF EXISTS "confirmation_attachments"`
    );
  }
}
