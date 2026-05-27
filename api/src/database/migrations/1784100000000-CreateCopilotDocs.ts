import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M9a — Copilot docs corpus (FAQ-grounded retrieval source).
 *
 * One row per (slug, locale). The hydrator at server boot reads
 * `dist/copilot/docs-bundle.json` (built by `scripts/build-copilot-docs.ts`)
 * and upserts changed rows. v1 retrieval is lexical (pg_trgm); the v2
 * embeddings table lives in a separate later migration so v1 deploys do
 * not require pgvector.
 *
 * `chatbot_` prefix per the shared-schema rule (n8n shares the public
 * schema). Explicit constraint names so they're recognisable in EXPLAIN
 * output and ALTER TABLE diagnostics.
 */
export class CreateCopilotDocs1784100000000 implements MigrationInterface {
  name = 'CreateCopilotDocs1784100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_copilot_docs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" varchar(128) NOT NULL,
        "locale" varchar(8) NOT NULL,
        "title" varchar(255) NOT NULL,
        "body" text NOT NULL,
        "tags" text[] NOT NULL DEFAULT '{}',
        "content_hash" varchar(64) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chatbot_copilot_docs" PRIMARY KEY ("id"),
        CONSTRAINT "uq_chatbot_copilot_docs_slug_locale" UNIQUE ("slug", "locale"),
        CONSTRAINT "chk_chatbot_copilot_docs_locale" CHECK ("locale" IN ('en','nl','fr'))
      )
    `);

    // Trigram GIN index over title + body for lexical retrieval.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chatbot_copilot_docs_trgm"
        ON "chatbot_copilot_docs"
        USING GIN (("title" || ' ' || "body") gin_trgm_ops)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_chatbot_copilot_docs_trgm"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_copilot_docs"`);
    // Extensions are NOT dropped — other migrations rely on uuid-ossp,
    // and pg_trgm is cheap to keep around even if Copilot is rolled back.
  }
}
