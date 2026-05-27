import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M6 — backfill leads from the legacy `chat_sessions.metadata.lead`
 * jsonb blob into the first-class `chatbot_leads` table.
 *
 * Pre-M6, `CaptureLeadTool` stored leads as `session.metadata.lead =
 * { name, email, phone, capturedAt }`. After M6 the tool writes to
 * `chatbot_leads` directly. This migration moves anything captured
 * before the cutover so the Leads page sees the full history.
 *
 * Idempotent: skips rows already present in `chatbot_leads` (matched
 * by session_id). Safe to re-run.
 *
 * The legacy `session.metadata.lead` key is LEFT IN PLACE on purpose
 * — n8n workflows that read it still work, and a future cleanup
 * migration can strip it once everything's switched over. No rush.
 *
 * `down()` is intentionally a no-op: the legacy data still exists on
 * the sessions, so this migration is "promote a copy," not "move."
 * Reverting just means trusting session.metadata.lead again, which
 * is still there.
 */
export class BackfillLeadsFromSessionMetadata1783200000000 implements MigrationInterface {
  name = 'BackfillLeadsFromSessionMetadata1783200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "chatbot_leads"
        ("id", "tenant_id", "session_id", "bot_id", "name", "email",
         "phone", "source", "metadata", "created_at", "updated_at")
      SELECT
        uuid_generate_v4(),
        s.tenant_id,
        s.id,
        s.bot_id,
        COALESCE(s.metadata #>> '{lead,name}', 'Unknown'),
        s.metadata #>> '{lead,email}',
        NULLIF(s.metadata #>> '{lead,phone}', ''),
        'tool',
        jsonb_build_object('backfilledFrom', 'session.metadata.lead'),
        COALESCE(
          (s.metadata #>> '{lead,capturedAt}')::timestamptz,
          s.created_at
        ),
        COALESCE(
          (s.metadata #>> '{lead,capturedAt}')::timestamptz,
          s.created_at
        )
      FROM "chat_sessions" s
      WHERE
        s.metadata ? 'lead'
        AND (s.metadata #>> '{lead,email}') IS NOT NULL
        AND (s.metadata #>> '{lead,email}') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM "chatbot_leads" l
          WHERE l.session_id = s.id
        )
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentional no-op. The legacy session.metadata.lead is still
    // there; reverting this migration leaves a duplicate in
    // chatbot_leads but no data is lost. The CreateLeadsTable
    // migration's `down()` will drop the table outright.
  }
}
