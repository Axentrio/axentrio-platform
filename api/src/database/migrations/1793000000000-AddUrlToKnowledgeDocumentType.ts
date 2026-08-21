import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Production created knowledge_documents.type as a native PG enum
 * (`knowledge_documents_type_enum`) from the TypeORM entity. The original
 * CreateKnowledgeTables used VARCHAR, so local synchronize DBs do not have
 * this type. ADD VALUE IF NOT EXISTS is a no-op when the type is missing.
 */
export class AddUrlToKnowledgeDocumentType1793000000000 implements MigrationInterface {
  name = 'AddUrlToKnowledgeDocumentType1793000000000';
  // ADD VALUE cannot run inside a transaction on some PG versions.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $block$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'knowledge_documents_type_enum'
        ) THEN
          ALTER TYPE knowledge_documents_type_enum ADD VALUE IF NOT EXISTS 'url';
        END IF;
      END
      $block$;
    `);
  }

  public async down(): Promise<void> {
    // PG cannot drop a single enum value safely.
  }
}
