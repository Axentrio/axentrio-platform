import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddKnowledgeDocumentSourceUrl1792900000000
  implements MigrationInterface
{
  name = "AddKnowledgeDocumentSourceUrl1792900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "knowledge_documents"
        ADD COLUMN IF NOT EXISTS "sourceUrl" varchar
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_knowledge_documents_kb_source_url"
        ON "knowledge_documents" ("knowledgeBaseId", "sourceUrl")
        WHERE "sourceUrl" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_knowledge_documents_kb_source_url"`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_documents" DROP COLUMN IF EXISTS "sourceUrl"`,
    );
  }
}
