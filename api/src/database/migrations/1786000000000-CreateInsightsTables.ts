import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Insights v1 (Gaps) foundations — ADR-0001..0007 + ADR-0013 / Deviation 36.
 *
 * Four tables:
 *  - chatbot_canonical_topics  per-tenant topic registry (ADR-0003)
 *  - chatbot_judgments         one LLM verdict per ChatSession (ADR-0004)
 *  - chatbot_gaps              Gap state, fingerprint (tenant, topic) (ADR-0005)
 *  - chatbot_insights_refresh_state  per-tenant watermark + completeness (ADR-0006)
 *
 * Statuses are varchar (not pg enums) per the newer-table convention
 * (chatbot_bookings) — avoids the test-enum vs prod-varchar drift.
 */
export class CreateInsightsTables1786000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_canonical_topics" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "topic" character varying(200) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_canonical_topics_tenant_topic" UNIQUE ("tenant_id", "topic")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_canonical_topics_tenant"
      ON "chatbot_canonical_topics" ("tenant_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_judgments" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "session_id" uuid NOT NULL,
        "visitor_id" character varying(255) NOT NULL,
        "session_started_at" timestamptz NOT NULL,
        "had_question" boolean NOT NULL,
        "satisfied" boolean,
        "topic_phrase" character varying(200),
        "canonical_topic_id" uuid,
        "rejected_topic" character varying(200),
        "reject_reason" character varying(64),
        "evidence_message_ids" jsonb NOT NULL DEFAULT '[]',
        "reasoning" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_judgments_session" UNIQUE ("session_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_judgments_tenant_created"
      ON "chatbot_judgments" ("tenant_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_judgments_tenant_topic_created"
      ON "chatbot_judgments" ("tenant_id", "canonical_topic_id", "created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_gaps" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "canonical_topic_id" uuid NOT NULL,
        "status" character varying(24) NOT NULL DEFAULT 'open',
        "severity" character varying(8) NOT NULL DEFAULT 'orange',
        "occurrences" integer NOT NULL DEFAULT 0,
        "distinct_visitors" integer NOT NULL DEFAULT 0,
        "first_detected_at" timestamptz NOT NULL,
        "last_seen_at" timestamptz NOT NULL,
        "resolved_at" timestamptz,
        "archived_at" timestamptz,
        "recommendation" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_gaps_tenant_topic" UNIQUE ("tenant_id", "canonical_topic_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_gaps_tenant_status"
      ON "chatbot_gaps" ("tenant_id", "status")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_insights_refresh_state" (
        "tenant_id" uuid PRIMARY KEY,
        "last_refreshed_at" timestamptz,
        "judgments_completeness" numeric(5,4),
        "last_run_error" text,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_insights_refresh_state"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_gaps"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_judgments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_canonical_topics"`);
  }
}
