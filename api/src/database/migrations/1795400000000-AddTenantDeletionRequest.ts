import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Self-service account deletion: request, dormancy, execution.
 *
 * Four columns rather than a `status` value, because the tenant's status is also
 * set by admins (suspend/activate) and a deletion request must not be silently
 * cleared by one. `deletion_scheduled_for` is what the daily sweep indexes.
 *
 * `deletion_paused_bot_ids` records WHICH bots the request paused, so cancelling
 * resumes those and leaves a deliberately paused bot alone.
 */
export class AddTenantDeletionRequest1795400000000 implements MigrationInterface {
  name = 'AddTenantDeletionRequest1795400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenants"
         ADD COLUMN IF NOT EXISTS "deletion_requested_at" timestamptz,
         ADD COLUMN IF NOT EXISTS "deletion_requested_by" uuid,
         ADD COLUMN IF NOT EXISTS "deletion_scheduled_for" timestamptz,
         ADD COLUMN IF NOT EXISTS "deletion_paused_bot_ids" uuid[]`,
    );
    // The sweep asks one question: which tenants are due? A partial index keeps
    // that cheap forever, since the overwhelming majority of rows are NULL.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tenants_deletion_scheduled_for"
         ON "tenants" ("deletion_scheduled_for")
         WHERE "deletion_scheduled_for" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tenants_deletion_scheduled_for"`);
    await queryRunner.query(
      `ALTER TABLE "tenants"
         DROP COLUMN IF EXISTS "deletion_requested_at",
         DROP COLUMN IF EXISTS "deletion_requested_by",
         DROP COLUMN IF EXISTS "deletion_scheduled_for",
         DROP COLUMN IF EXISTS "deletion_paused_bot_ids"`,
    );
  }
}
