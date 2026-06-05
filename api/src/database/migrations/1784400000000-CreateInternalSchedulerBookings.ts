import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Internal scheduler — bookings table (Phase 0, slice #3).
 *
 * The source-of-truth appointment store for the internal provider. Concurrency
 * safety is declarative: a buffer-aware GiST exclusion constraint on
 * (`calendar_key`, `blocked_range`) prevents overlapping `pending`/`confirmed`
 * bookings on the same calendar resource — so two racing creates can never
 * double-book; the loser gets a `23P01` exclusion_violation which the provider
 * maps to `SLOT_UNAVAILABLE`. `blocked_range` already includes the event's
 * before/after buffers, so buffers are enforced atomically, not just in app code.
 *
 * The table is created brand-new WITH the constraints in this migration, so
 * there is no backfill/validation pass against existing rows and no heavy lock.
 */
export class CreateInternalSchedulerBookings1784400000000 implements MigrationInterface {
  name = 'CreateInternalSchedulerBookings1784400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Required for the (text =, tstzrange &&) exclusion constraint.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_bookings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "bot_id" uuid NOT NULL,
        "provider" varchar(16) NOT NULL DEFAULT 'internal',
        "event_type_id" uuid NULL,
        "session_id" uuid NULL,
        "status" varchar(24) NOT NULL DEFAULT 'pending',
        "sync_pending" boolean NOT NULL DEFAULT false,
        "start_utc" timestamptz NOT NULL,
        "end_utc" timestamptz NOT NULL,
        "blocked_range" tstzrange NOT NULL,
        "calendar_key" text NOT NULL,
        "attendee_name" varchar(255) NULL,
        "attendee_email" varchar(320) NULL,
        "notes" text NULL,
        "ics_uid" varchar(255) NOT NULL,
        "sequence" int NOT NULL DEFAULT 0,
        "reminder_job_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "idempotency_key" varchar(255) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chatbot_bookings" PRIMARY KEY ("id"),
        CONSTRAINT "chk_chatbot_bookings_range" CHECK ("end_utc" > "start_utc"),
        CONSTRAINT "fk_chatbot_bookings_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_bookings_bot"
          FOREIGN KEY ("bot_id") REFERENCES "chatbot_bots"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_bookings_event_type"
          FOREIGN KEY ("event_type_id") REFERENCES "chatbot_event_types"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_chatbot_bookings_session"
          FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE SET NULL,
        CONSTRAINT "excl_chatbot_bookings_slot"
          EXCLUDE USING gist ("calendar_key" WITH =, "blocked_range" WITH &&)
          WHERE ("status" IN ('pending', 'confirmed'))
      )
    `);

    // Idempotency: one live booking per (tenant, bot, key). Failed attempts and
    // null keys are excluded so a failed create doesn't permanently block retry.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_bookings_idempotency"
        ON "chatbot_bookings" ("tenant_id", "bot_id", "idempotency_key")
        WHERE "idempotency_key" IS NOT NULL AND "status" <> 'failed'
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chatbot_bookings_lookup"
        ON "chatbot_bookings" ("tenant_id", "bot_id", "status")
    `);

    // Busy-time lookups by calendar resource.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chatbot_bookings_calendar"
        ON "chatbot_bookings" ("calendar_key", "status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_bookings"`);
  }
}
