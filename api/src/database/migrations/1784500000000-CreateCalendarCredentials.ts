import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Internal scheduler — calendar credentials (Phase 1, slice #8).
 *
 * Stores a bot owner's connected external calendar (Google in v1) with
 * encrypted OAuth tokens. One active credential per bot. `calendar_id` is both
 * the write destination and the busy-check source for v1.
 */
export class CreateCalendarCredentials1784500000000 implements MigrationInterface {
  name = 'CreateCalendarCredentials1784500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_calendar_credentials" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "bot_id" uuid NOT NULL,
        "provider" varchar(16) NOT NULL DEFAULT 'google',
        "status" varchar(16) NOT NULL DEFAULT 'active',
        "account_email" varchar(320) NULL,
        "access_token_enc" text NOT NULL,
        "refresh_token_enc" text NULL,
        "token_expiry" timestamptz NULL,
        "calendar_id" varchar(320) NOT NULL DEFAULT 'primary',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chatbot_calendar_credentials" PRIMARY KEY ("id"),
        CONSTRAINT "fk_chatbot_calendar_credentials_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_calendar_credentials_bot"
          FOREIGN KEY ("bot_id") REFERENCES "chatbot_bots"("id") ON DELETE CASCADE
      )
    `);

    // One active calendar connection per bot+provider.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_calendar_credentials_active"
        ON "chatbot_calendar_credentials" ("bot_id", "provider")
        WHERE "status" = 'active'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_calendar_credentials"`);
  }
}
