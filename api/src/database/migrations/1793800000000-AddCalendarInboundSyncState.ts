import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inbound calendar sync — opaque provider cursor and lease state on the credential.
 *
 * Google `nextSyncToken` and Graph `@odata.deltaLink` are change pointers, not
 * bearer credentials, so they sit in plain text beside the encrypted tokens.
 */
export class AddCalendarInboundSyncState1793800000000 implements MigrationInterface {
  name = 'AddCalendarInboundSyncState1793800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_calendar_credentials"
        ADD COLUMN IF NOT EXISTS "inbound_sync_cursor" text,
        ADD COLUMN IF NOT EXISTS "inbound_synced_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "inbound_claimed_until" timestamptz,
        ADD COLUMN IF NOT EXISTS "inbound_attempts" int NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "inbound_last_error" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_calendar_credentials"
        DROP COLUMN IF EXISTS "inbound_sync_cursor",
        DROP COLUMN IF EXISTS "inbound_synced_at",
        DROP COLUMN IF EXISTS "inbound_claimed_until",
        DROP COLUMN IF EXISTS "inbound_attempts",
        DROP COLUMN IF EXISTS "inbound_last_error"
    `);
  }
}
