import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Global AI Workflow Guardrails — Slice 1 schema
 * (.scratch/plan-global-ai-guardrails.md §3).
 *
 * Adds the guardrail-state columns and the spam/scam detection log:
 *   - chat_sessions.ai_auto_reply_enabled  — the safety-layer "AI may reply" gate
 *   - chat_sessions.guardrail_status       — normal | spam | scam | … (varchar, not enum)
 *   - messages.guardrail_flagged           — exclude this message from AI history
 *   - guardrail_spam_logs                  — append-only detection record
 *
 * Defaults (true / 'normal' / false) mean NO backfill of existing rows.
 *
 * Shapes mirror entities/{ChatSession,Message,SpamScamLog}.ts — tests build the
 * schema from those entities via synchronize (migrations do not run in test), so
 * the two MUST stay in step. guardrail_status/detected_category are varchar (not
 * enum) to match the entities and avoid the prod-enum/test-varchar divergence.
 *
 * Idempotent (IF NOT EXISTS) so it is safe to re-run.
 */
export class AddGuardrailsSchema1786800000000 implements MigrationInterface {
  name = 'AddGuardrailsSchema1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_sessions" ADD COLUMN IF NOT EXISTS "ai_auto_reply_enabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_sessions" ADD COLUMN IF NOT EXISTS "guardrail_status" varchar(32) NOT NULL DEFAULT 'normal'`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "guardrail_flagged" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "guardrail_checked" boolean NOT NULL DEFAULT false`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "guardrail_spam_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "source_channel" varchar(32) NOT NULL,
        "suspicious_message_id" uuid,
        "detected_category" varchar(32) NOT NULL,
        "suspicious_links_detected" boolean NOT NULL DEFAULT false,
        "repeated_message_detected" boolean NOT NULL DEFAULT false,
        "bot_loop_detected" boolean NOT NULL DEFAULT false,
        "ai_auto_reply_disabled" boolean NOT NULL DEFAULT false,
        "notification_sent" boolean NOT NULL DEFAULT false,
        "score" numeric(3,2),
        "reasons" jsonb,
        "enforced" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_guardrail_spam_logs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_guardrail_spam_logs_tenant_created"
        ON "guardrail_spam_logs" ("tenant_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_guardrail_spam_logs_conversation"
        ON "guardrail_spam_logs" ("conversation_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "guardrail_spam_logs"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "guardrail_checked"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "guardrail_flagged"`);
    await queryRunner.query(`ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "guardrail_status"`);
    await queryRunner.query(`ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "ai_auto_reply_enabled"`);
  }
}
