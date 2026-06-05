import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Internal scheduler — availability tables (Phase 0, slice #2).
 *
 * `chatbot_event_types` (bookable services) and `chatbot_availability_rules`
 * (weekly hours + overrides) back the internal booking provider's slot engine.
 * The `bookings` table and its exclusion constraint arrive in a later slice.
 *
 * `chatbot_` prefix per the shared-schema rule (n8n shares this Postgres
 * `public` schema). v1 enforces a single active event type per bot via a
 * partial unique index, and a single availability rule per bot.
 */
export class CreateInternalSchedulerAvailability1784300000000 implements MigrationInterface {
  name = 'CreateInternalSchedulerAvailability1784300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_event_types" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "bot_id" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "slug" varchar(255) NOT NULL,
        "duration_min" int NOT NULL DEFAULT 30,
        "buffer_before_min" int NOT NULL DEFAULT 0,
        "buffer_after_min" int NOT NULL DEFAULT 0,
        "min_notice_min" int NOT NULL DEFAULT 0,
        "max_horizon_days" int NOT NULL DEFAULT 60,
        "location_type" varchar(32) NOT NULL DEFAULT 'custom',
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chatbot_event_types" PRIMARY KEY ("id"),
        CONSTRAINT "fk_chatbot_event_types_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_event_types_bot"
          FOREIGN KEY ("bot_id") REFERENCES "chatbot_bots"("id") ON DELETE CASCADE
      )
    `);

    // v1: at most one active event type per bot.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_event_types_active_bot"
        ON "chatbot_event_types" ("bot_id")
        WHERE "is_active" = true
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_availability_rules" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "bot_id" uuid NOT NULL,
        "timezone" varchar(64) NOT NULL DEFAULT 'UTC',
        "weekly_hours" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "date_overrides" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "slot_granularity_min" int NOT NULL DEFAULT 30,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chatbot_availability_rules" PRIMARY KEY ("id"),
        CONSTRAINT "fk_chatbot_availability_rules_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_availability_rules_bot"
          FOREIGN KEY ("bot_id") REFERENCES "chatbot_bots"("id") ON DELETE CASCADE
      )
    `);

    // One availability rule per bot.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_availability_rules_bot"
        ON "chatbot_availability_rules" ("bot_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_availability_rules"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_event_types"`);
  }
}
