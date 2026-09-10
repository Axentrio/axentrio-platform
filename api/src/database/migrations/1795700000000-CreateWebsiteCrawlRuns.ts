import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Per-origin crawl outcome. A refused origin stores no documents, so the
 * skip and refuse facts cannot live on knowledge_documents.
 */
export class CreateWebsiteCrawlRuns1795700000000 implements MigrationInterface {
  name = "CreateWebsiteCrawlRuns1795700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "website_crawl_runs" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "tenantId" uuid NOT NULL,
        "knowledgeBaseId" uuid NOT NULL,
        "origin" varchar(2048) NOT NULL,
        "skippedByRules" integer NOT NULL DEFAULT 0,
        "rulesUnreachable" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_website_crawl_runs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_website_crawl_runs_origin" UNIQUE ("tenantId", "knowledgeBaseId", "origin"),
        CONSTRAINT "FK_website_crawl_runs_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_website_crawl_runs_kb" FOREIGN KEY ("knowledgeBaseId")
          REFERENCES "knowledge_bases"("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "website_crawl_runs"`);
  }
}
