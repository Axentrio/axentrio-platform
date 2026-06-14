import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P3 — Enterprise "AI Business Insights" foundations.
 * Design: .scratch/plan-p3-business-insights.md (ADR-0014 at build kickoff).
 *
 * Three new tables + an additive ALTER:
 *  - chatbot_insight_experiments  correlation + sentiment (D1; NO resolution column —
 *    CHECK on kind/state physically forbids a "resolved experiment" per ADR-0001)
 *  - chatbot_insight_digests      one row per tenant per ISO week + email outbox (D6)
 *  - chatbot_sentiment_themes     per-tenant recurring-theme registry (D5)
 *  - chatbot_judgments            + nullable sentiment / sentiment_theme_id (D5)
 *
 * varchar + CHECK (not pg enums) — house convention (avoids test-enum vs prod-varchar
 * drift). Idempotent (IF NOT EXISTS) — safe to re-run.
 */
export class CreateBusinessInsightsTables1786300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Experiments — correlation + sentiment. No status/resolved column exists, AND the
    // state domain is CHECK-constrained: a resolved experiment is unwritable two ways.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_insight_experiments" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "kind" character varying(16) NOT NULL,
        "fingerprint" character varying(200) NOT NULL,
        "severity" character varying(8) NOT NULL DEFAULT 'orange',
        "title" text NOT NULL,
        "detail" text,
        "payload" jsonb NOT NULL DEFAULT '{}',
        "state" character varying(16) NOT NULL DEFAULT 'active',
        "first_seen_at" timestamptz NOT NULL DEFAULT now(),
        "last_seen_at" timestamptz NOT NULL DEFAULT now(),
        "dismissed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_experiments_tenant_kind_fp" UNIQUE ("tenant_id", "kind", "fingerprint"),
        CONSTRAINT "chk_experiments_kind" CHECK ("kind" IN ('correlation', 'sentiment')),
        CONSTRAINT "chk_experiments_state" CHECK ("state" IN ('active', 'dismissed'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_experiments_tenant_state"
      ON "chatbot_insight_experiments" ("tenant_id", "state")
    `);

    // Digests — one row per tenant per summarized week; the row IS the email outbox.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_insight_digests" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "week_start" date NOT NULL,
        "summary_md" text NOT NULL,
        "metrics" jsonb NOT NULL DEFAULT '{}',
        "send_state" character varying(16) NOT NULL DEFAULT 'pending',
        "send_started_at" timestamptz,
        "send_claimed_until" timestamptz,
        "send_next_attempt_at" timestamptz,
        "send_attempts" integer NOT NULL DEFAULT 0,
        "provider_message_id" character varying(255),
        "last_send_error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_digests_tenant_week" UNIQUE ("tenant_id", "week_start"),
        CONSTRAINT "chk_digests_send_state"
          CHECK ("send_state" IN ('pending', 'sending', 'sent', 'failed', 'skipped'))
      )
    `);
    // Partial index for the send reconciler's claimable-row scan.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_digests_sendable"
      ON "chatbot_insight_digests" ("send_next_attempt_at")
      WHERE "send_state" IN ('pending', 'sending', 'failed')
    `);

    // Sentiment themes — per-tenant recurring-theme registry, SEPARATE from the Gap
    // canonical-topic registry (Gap topics drive Gap lifecycle; conflating pollutes it).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_sentiment_themes" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "theme" character varying(200) NOT NULL,
        "polarity" character varying(8) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_sentiment_themes_tenant_theme" UNIQUE ("tenant_id", "theme"),
        CONSTRAINT "chk_sentiment_themes_polarity"
          CHECK ("polarity" IN ('positive', 'negative', 'neutral'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sentiment_themes_tenant"
      ON "chatbot_sentiment_themes" ("tenant_id")
    `);

    // Judgments gain nullable sentiment fields (Enterprise-only, forward-only — D5).
    await queryRunner.query(`
      ALTER TABLE "chatbot_judgments"
      ADD COLUMN IF NOT EXISTS "sentiment" character varying(8)
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_judgments"
      ADD COLUMN IF NOT EXISTS "sentiment_theme_id" uuid
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chatbot_judgments" DROP COLUMN IF EXISTS "sentiment_theme_id"`);
    await queryRunner.query(`ALTER TABLE "chatbot_judgments" DROP COLUMN IF EXISTS "sentiment"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_sentiment_themes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_insight_digests"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_insight_experiments"`);
  }
}
