import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Story 3 Release A — the per-conversation lead grain, plus the booking link.
 *
 * `chatbot_leads` is one row per durable contact (deduped on `dedupe_key`). That
 * cannot express Story 3's per-conversation fields: a returning customer collapses
 * onto the same row, and the upsert keeps only the LATEST `session_id` and `notes`,
 * so the identity row silently describes whichever conversation touched it last.
 *
 * Two additive structures fix that:
 *   - `chatbot_lead_conversations` — one row per (lead, conversation).
 *   - `chatbot_bookings.lead_id` — so address / requested service / preferred date /
 *     status / list price are DERIVED by join instead of copied onto the lead. A
 *     session can hold 0..n bookings and neither reschedule nor cancel notifies the
 *     lead, so any cached copy would go stale invisibly.
 *
 * DELIBERATELY ABSENT:
 *   - No CHECK on `urgency` / `intent` / `enrich_state`'s model-adjacent values. These
 *     vocabularies are produced by an LLM behind an app-side allowlist; a DB CHECK
 *     would turn a bad generation into a failed transaction, and widening it later
 *     means an ALTER under load.
 *   - No backfill. `chatbot_leads.session_id` points at the NEWEST session, so
 *     seeding one conversation row per existing lead would stamp the latest
 *     conversation as if it were the whole history — most confidently wrong on
 *     exactly the repeat customers the table exists to serve. Existing leads simply
 *     have no conversation rows and render as "not analyzed".
 *
 * UNLIKE the previous leads migration, `chatbot_leads` is now POPULATED in prod, so
 * "0 rows, risk-free" no longer applies: every statement here is additive
 * (CREATE TABLE / ADD COLUMN / CREATE INDEX), nothing rewrites the existing table,
 * and there is no full-table UPDATE that would hold a lock. The index on the new,
 * empty table is created normally (nothing to scan); indexes on the populated
 * `chatbot_bookings` use CONCURRENTLY in a separate migration.
 *
 * All statements are IF (NOT) EXISTS-guarded and safe to re-run.
 */
export class AddLeadConversations1787500000000 implements MigrationInterface {
  name = 'AddLeadConversations1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── The per-conversation grain ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_lead_conversations" (
        -- uuid_generate_v4() (uuid-ossp), NOT gen_random_uuid(): every other table
        -- in this schema uses it, and the test bootstrap installs that extension.
        "id"                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenant_id"              uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
        "lead_id"                uuid NOT NULL REFERENCES "chatbot_leads"("id") ON DELETE CASCADE,
        "session_id"             uuid REFERENCES "chat_sessions"("id") ON DELETE SET NULL,
        "bot_id"                 uuid,
        "channel"                varchar(32),

        -- Extracted per-conversation detail (Release B writes these; NULL until then).
        -- Every column is nullable because the extractor is fail-closed: "could not
        -- establish this" is the normal outcome and must be representable.
        "request"                text,
        "service_requested"      varchar(160),
        "address"                varchar(512),
        "preferred_at"           timestamptz,
        "preferred_at_text"      varchar(160),
        "urgency"                varchar(16),
        "intent"                 varchar(24),
        "tags"                   text[],
        "enrichment"             jsonb NOT NULL DEFAULT '{}'::jsonb,
        "evidence"               jsonb NOT NULL DEFAULT '[]'::jsonb,

        -- Enrichment control.
        "enrich_state"           varchar(24) NOT NULL DEFAULT 'pending',
        -- CAS target: the chat_sessions.transcript_revision this row was enriched
        -- against. A message inserted/edited/deleted mid-extraction advances that
        -- revision, the compare-and-swap fails, and the work is requeued instead of
        -- committing a stale reading.
        "enriched_revision"      int,
        "enrich_attempts"        smallint NOT NULL DEFAULT 0,
        "enrich_next_attempt_at" timestamptz,
        "enrich_claimed_until"   timestamptz,
        "enrich_last_error"      text,
        "enrichment_version"     smallint,
        "model"                  varchar(64),
        "prompt_version"         varchar(32),
        "extracted_language"     varchar(8),

        "source"                 varchar(16) NOT NULL DEFAULT 'link',
        "created_at"             timestamptz NOT NULL DEFAULT now(),
        "updated_at"             timestamptz NOT NULL DEFAULT now()
      )
    `);

    // The association invariant: one conversation maps to at most ONE lead. Without
    // it, concurrent capture paths could link the same session to two leads and the
    // detail view would show a conversation under two different contacts.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_lead_conv_tenant_session"
        ON "chatbot_lead_conversations" ("tenant_id", "session_id")
        WHERE "session_id" IS NOT NULL
    `);

    // One lead's conversation history, newest first — the detail drawer's read.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_lead_conv_lead"
        ON "chatbot_lead_conversations" ("lead_id", "created_at" DESC)
    `);

    // The enrichment sweep's claim query: due, unclaimed work only.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_lead_conv_enrich_due"
        ON "chatbot_lead_conversations" ("enrich_next_attempt_at")
        WHERE "enrich_state" IN ('pending', 'failed')
    `);

    // ── Booking → lead link (facts derived by join, never copied) ───────────
    await queryRunner.query(`ALTER TABLE "chatbot_bookings" ADD COLUMN IF NOT EXISTS "lead_id" uuid`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chatbot_bookings" DROP COLUMN IF EXISTS "lead_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_lead_conv_enrich_due"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_lead_conv_lead"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ux_lead_conv_tenant_session"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_lead_conversations"`);
  }
}
