import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDailyLlmCallLimit1780300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenants"
      ADD COLUMN "daily_llm_call_limit" integer
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenants"
      DROP COLUMN IF EXISTS "daily_llm_call_limit"
    `);
  }
}
