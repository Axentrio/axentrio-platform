import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keystone K1: turn the single bookable event type into a multi-service catalog.
 *
 * - Rename `chatbot_event_types` → `chatbot_service_types` (PK/FKs follow the
 *   table automatically; `chatbot_bookings.event_type_id` keeps its name so
 *   analytics/webhooks/admin payloads referencing it don't break).
 * - Drop the single-active-per-bot unique index → allow N active services.
 * - Add the spec's per-service columns (booking mode, pricing, duration modes,
 *   location flags, capacity, …) — added now even where behaviour lands later, so
 *   prod isn't re-migrated per slice.
 * - Add a `(bot_id, slug)` unique index as the new addressability guarantee.
 * - Add the spec's per-booking columns (one Booking table; a request is just
 *   `status='request_created'`).
 */
export class RenameEventTypeToServiceType1785200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chatbot_event_types" RENAME TO "chatbot_service_types"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "uq_chatbot_event_types_active_bot"`);

    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ADD COLUMN IF NOT EXISTS "category" varchar(255),
        ADD COLUMN IF NOT EXISTS "description" text,
        ADD COLUMN IF NOT EXISTS "booking_mode" varchar(16) NOT NULL DEFAULT 'auto',
        ADD COLUMN IF NOT EXISTS "online_bookable" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "duration_mode" varchar(16) NOT NULL DEFAULT 'fixed',
        ADD COLUMN IF NOT EXISTS "min_duration_min" int,
        ADD COLUMN IF NOT EXISTS "max_duration_min" int,
        ADD COLUMN IF NOT EXISTS "price_display_type" varchar(16) NOT NULL DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS "fixed_price" numeric(10,2),
        ADD COLUMN IF NOT EXISTS "min_price" numeric(10,2),
        ADD COLUMN IF NOT EXISTS "max_price" numeric(10,2),
        ADD COLUMN IF NOT EXISTS "price_note" varchar(255),
        ADD COLUMN IF NOT EXISTS "customer_location_required" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "customer_address_required" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "file_upload_allowed" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "max_bookings_per_day" int,
        ADD COLUMN IF NOT EXISTS "preparation_instructions" text,
        ADD COLUMN IF NOT EXISTS "sort_order" int NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_service_types_bot_slug"
        ON "chatbot_service_types" ("bot_id", "slug")
    `);

    await queryRunner.query(`
      ALTER TABLE "chatbot_bookings"
        ADD COLUMN IF NOT EXISTS "booking_mode" varchar(16),
        ADD COLUMN IF NOT EXISTS "source_channel" varchar(32),
        ADD COLUMN IF NOT EXISTS "intake_answers" jsonb,
        ADD COLUMN IF NOT EXISTS "uploaded_files" jsonb,
        ADD COLUMN IF NOT EXISTS "ai_summary" text,
        ADD COLUMN IF NOT EXISTS "customer_phone" varchar(64),
        ADD COLUMN IF NOT EXISTS "customer_address" varchar(512)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_bookings"
        DROP COLUMN IF EXISTS "booking_mode",
        DROP COLUMN IF EXISTS "source_channel",
        DROP COLUMN IF EXISTS "intake_answers",
        DROP COLUMN IF EXISTS "uploaded_files",
        DROP COLUMN IF EXISTS "ai_summary",
        DROP COLUMN IF EXISTS "customer_phone",
        DROP COLUMN IF EXISTS "customer_address"
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "uq_chatbot_service_types_bot_slug"`);

    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        DROP COLUMN IF EXISTS "category",
        DROP COLUMN IF EXISTS "description",
        DROP COLUMN IF EXISTS "booking_mode",
        DROP COLUMN IF EXISTS "online_bookable",
        DROP COLUMN IF EXISTS "duration_mode",
        DROP COLUMN IF EXISTS "min_duration_min",
        DROP COLUMN IF EXISTS "max_duration_min",
        DROP COLUMN IF EXISTS "price_display_type",
        DROP COLUMN IF EXISTS "fixed_price",
        DROP COLUMN IF EXISTS "min_price",
        DROP COLUMN IF EXISTS "max_price",
        DROP COLUMN IF EXISTS "price_note",
        DROP COLUMN IF EXISTS "customer_location_required",
        DROP COLUMN IF EXISTS "customer_address_required",
        DROP COLUMN IF EXISTS "file_upload_allowed",
        DROP COLUMN IF EXISTS "max_bookings_per_day",
        DROP COLUMN IF EXISTS "preparation_instructions",
        DROP COLUMN IF EXISTS "sort_order"
    `);

    // Restore the single-active index before renaming back (fails loudly if
    // multiple active services per bot now exist — intentional).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_event_types_active_bot"
        ON "chatbot_service_types" ("bot_id") WHERE "is_active" = true
    `);
    await queryRunner.query(`ALTER TABLE "chatbot_service_types" RENAME TO "chatbot_event_types"`);
  }
}
