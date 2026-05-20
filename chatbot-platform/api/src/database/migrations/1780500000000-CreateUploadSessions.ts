import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Create the `upload_sessions` table backing the UploadSession entity.
 *
 * Replaces the in-memory `uploadSessions` Map in upload.service.ts so the
 * two halves of an upload (presigned-URL request + scan-complete callback)
 * survive replica switches and deploys.
 *
 * Pure DDL — no data backfill needed because the prior storage was
 * in-memory only.
 */
export class CreateUploadSessions1780500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enum type for status. Mirrors UploadSession.status values.
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "upload_sessions_status_enum" AS ENUM (
          'pending', 'uploading', 'scanning', 'ready', 'failed', 'quarantined'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "upload_sessions" (
        "session_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "chat_session_id" uuid NOT NULL,
        "user_id" varchar(255) NOT NULL,
        "file_key" varchar(500) NOT NULL,
        "file_hash" varchar(64) NOT NULL,
        "original_name" varchar(255) NOT NULL,
        "file_size" bigint NOT NULL,
        "mime_type" varchar(100) NOT NULL,
        "upload_url" varchar(2000) NOT NULL,
        "public_url" varchar(2000) NOT NULL,
        "status" "upload_sessions_status_enum" NOT NULL DEFAULT 'pending',
        "scan_result" jsonb,
        "thumbnail_url" varchar(2000),
        "expires_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_upload_sessions" PRIMARY KEY ("session_id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_upload_sessions_tenant_created" ON "upload_sessions" ("tenant_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_upload_sessions_chat_session" ON "upload_sessions" ("chat_session_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_upload_sessions_file_key" ON "upload_sessions" ("file_key")`,
    );
    // Used by cleanupExpiredSessions to find expired rows in non-terminal
    // statuses cheaply.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_upload_sessions_status_expires" ON "upload_sessions" ("status", "expires_at")`,
    );

    // FK to tenants — cascade on delete so a tenant deletion takes its
    // upload sessions with it.
    await queryRunner.query(`
      ALTER TABLE "upload_sessions"
      ADD CONSTRAINT "FK_upload_sessions_tenant"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
    `);

    // No FK to chat_sessions: upload sessions can legitimately outlive
    // their chat session (e.g. quarantined files retained for audit even
    // after the conversation ends).
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "upload_sessions" DROP CONSTRAINT IF EXISTS "FK_upload_sessions_tenant"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "upload_sessions"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "upload_sessions_status_enum"`);
  }
}
