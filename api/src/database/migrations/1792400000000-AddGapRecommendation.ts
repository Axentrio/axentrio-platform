import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGapRecommendation1792400000000 implements MigrationInterface {
  name = 'AddGapRecommendation1792400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_gaps"
        ADD COLUMN IF NOT EXISTS "recommendation" text,
        ADD COLUMN IF NOT EXISTS "recommendation_updated_at" timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_gaps"
        DROP COLUMN IF EXISTS "recommendation_updated_at",
        DROP COLUMN IF EXISTS "recommendation"
    `);
  }
}
