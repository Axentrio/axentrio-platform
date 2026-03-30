import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddQualityReportColumn1775600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "knowledge_documents"
      ADD COLUMN "qualityReport" jsonb DEFAULT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "knowledge_documents"
      DROP COLUMN IF EXISTS "qualityReport"
    `);
  }
}
