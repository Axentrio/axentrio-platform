import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SV — file upload is always allowed. The service flag is now "required",
 * not "allowed". Existing true values stay optional: do not copy them.
 */
export class AddFileUploadRequired1794000000000 implements MigrationInterface {
  name = 'AddFileUploadRequired1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ADD COLUMN IF NOT EXISTS "file_upload_required" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        DROP COLUMN IF EXISTS "file_upload_allowed"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ADD COLUMN IF NOT EXISTS "file_upload_allowed" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        DROP COLUMN IF EXISTS "file_upload_required"
    `);
  }
}
