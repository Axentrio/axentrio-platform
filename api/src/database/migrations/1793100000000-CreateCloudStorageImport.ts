import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCloudStorageImport1793100000000
  implements MigrationInterface
{
  name = "CreateCloudStorageImport1793100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "knowledge_storage_connections" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "provider" varchar(32) NOT NULL,
        "provider_account_id" varchar(320) NOT NULL,
        "account_email" varchar(320) NULL,
        "status" varchar(16) NOT NULL DEFAULT 'active',
        "reauth_required" boolean NOT NULL DEFAULT false,
        "access_token_enc" text NOT NULL,
        "refresh_token_enc" text NULL,
        "token_expiry" timestamptz NULL,
        "connected_by_user_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_knowledge_storage_connections" PRIMARY KEY ("id"),
        CONSTRAINT "fk_knowledge_storage_connections_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_knowledge_storage_connections_user"
          FOREIGN KEY ("connected_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_knowledge_storage_connections_account"
        ON "knowledge_storage_connections" ("tenant_id", "provider", "provider_account_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "storage_import_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "knowledge_base_id" uuid NOT NULL,
        "storage_connection_id" uuid NOT NULL,
        "provider" varchar(32) NOT NULL,
        "file_id" varchar(320) NOT NULL,
        "target_key" varchar(1024) NOT NULL,
        "status" varchar(32) NOT NULL DEFAULT 'queued',
        "error" text NULL,
        "document_id" uuid NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_storage_import_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "fk_storage_import_jobs_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_storage_import_jobs_kb"
          FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_storage_import_jobs_connection"
          FOREIGN KEY ("storage_connection_id") REFERENCES "knowledge_storage_connections"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_storage_import_jobs_tenant"
        ON "storage_import_jobs" ("tenant_id")
    `);

    await queryRunner.query(`
      ALTER TABLE "knowledge_documents"
        ADD COLUMN IF NOT EXISTS "storageProvider" varchar,
        ADD COLUMN IF NOT EXISTS "storageFileId" varchar
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_knowledge_documents_kb_storage_file"
        ON "knowledge_documents" ("knowledgeBaseId", "storageProvider", "storageFileId")
        WHERE "storageProvider" IS NOT NULL AND "storageFileId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_knowledge_documents_kb_storage_file"`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_documents" DROP COLUMN IF EXISTS "storageFileId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_documents" DROP COLUMN IF EXISTS "storageProvider"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "storage_import_jobs"`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "knowledge_storage_connections"`,
    );
  }
}
