import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Business-level booking settings — the home for a bot's service area.
 *
 * Additive and empty on arrival: no row is created for any existing bot, and a bot with no
 * row has no service area, which is exactly how every bot behaved before this migration.
 * Nothing to backfill and nothing to reverse beyond dropping the table.
 *
 * `chatbot_` prefix per the shared-schema rule (n8n shares this Postgres `public` schema).
 */
export class CreateBookingSettings1788500000000 implements MigrationInterface {
  name = 'CreateBookingSettings1788500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_booking_settings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "bot_id" uuid NOT NULL,
        "service_area" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chatbot_booking_settings" PRIMARY KEY ("id"),
        CONSTRAINT "fk_chatbot_booking_settings_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_booking_settings_bot"
          FOREIGN KEY ("bot_id") REFERENCES "chatbot_bots"("id") ON DELETE CASCADE
      )
    `);

    // One settings row per bot — the lazy upsert on write depends on this.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_booking_settings_bot"
        ON "chatbot_booking_settings" ("bot_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_booking_settings"`);
  }
}
