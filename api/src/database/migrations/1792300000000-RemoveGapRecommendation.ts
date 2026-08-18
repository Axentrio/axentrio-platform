import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveGapRecommendation1792300000000 implements MigrationInterface {
  name = 'RemoveGapRecommendation1792300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_gaps"
        DROP COLUMN IF EXISTS "recommendation"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_gaps"
        ADD COLUMN IF NOT EXISTS "recommendation" text
    `);
  }
}
