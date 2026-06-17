import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Global AI Workflow Guardrails — Slice 2 output-validation decision log
 * (.scratch/plan-global-ai-guardrails.md, AC13/AC14).
 *
 * Adds guardrail_output_logs — an append-only record of every flagged AI reply
 * (one row per detection, including shadow-mode observations). Sibling of
 * guardrail_spam_logs (inbound); together they are the guardrails journal.
 *
 * Shape mirrors entities/GuardrailOutputLog.ts — tests build the schema from
 * entities via synchronize (migrations do not run in test), so the two MUST stay
 * in step. families/reasons are jsonb; generation_path/source_channel varchar
 * (no enums) to avoid the prod-enum/test-varchar divergence.
 *
 * Idempotent (IF NOT EXISTS) so it is safe to re-run.
 */
export class AddGuardrailOutputLog1786810000000 implements MigrationInterface {
  name = 'AddGuardrailOutputLog1786810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "guardrail_output_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "source_channel" varchar(32) NOT NULL,
        "outbound_message_id" uuid,
        "generation_path" varchar(16) NOT NULL,
        "families" jsonb NOT NULL,
        "reasons" jsonb,
        "enforced" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_guardrail_output_logs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_guardrail_output_logs_tenant_created"
        ON "guardrail_output_logs" ("tenant_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_guardrail_output_logs_conversation"
        ON "guardrail_output_logs" ("conversation_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "guardrail_output_logs"`);
  }
}
