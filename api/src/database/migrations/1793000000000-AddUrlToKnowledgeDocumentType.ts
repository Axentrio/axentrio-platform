import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Production created knowledge_documents.type as a native PG enum
 * (`knowledge_documents_type_enum`) from the TypeORM entity. Migration-built
 * databases keep the original varchar from CreateKnowledgeTables, which
 * already accepts 'url' — skip when the enum is absent.
 *
 * ADD VALUE IF NOT EXISTS is idempotent. TypeORM global transaction mode is
 * "all", so this migration must not set transaction = false. PG 12+ allows
 * ADD VALUE inside a transaction if the new value is unused in it.
 */
export class AddUrlToKnowledgeDocumentType1793000000000
  implements MigrationInterface
{
  name = "AddUrlToKnowledgeDocumentType1793000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const result = await queryRunner.query(
      `SELECT 1 FROM pg_type WHERE typname = 'knowledge_documents_type_enum'`,
    );
    if (result.length === 0) return;
    await queryRunner.query(
      `ALTER TYPE knowledge_documents_type_enum ADD VALUE IF NOT EXISTS 'url'`,
    );
  }

  public async down(): Promise<void> {
    // PG cannot drop a single enum value safely.
  }
}
