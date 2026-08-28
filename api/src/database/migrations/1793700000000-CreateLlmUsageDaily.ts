import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLlmUsageDaily1793700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "llm_usage_daily" (
        "day" date NOT NULL,
        "tenant_id" uuid NOT NULL,
        "path" varchar(48) NOT NULL,
        "model" varchar(64) NOT NULL,
        "calls" bigint NOT NULL DEFAULT 0,
        "prompt_tokens" bigint NOT NULL DEFAULT 0,
        "completion_tokens" bigint NOT NULL DEFAULT 0,
        "cost_usd" numeric(14,6) NOT NULL DEFAULT 0,
        CONSTRAINT "PK_llm_usage_daily" PRIMARY KEY ("day", "tenant_id", "path", "model")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_usage_daily"`);
  }
}
