import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGuardrailAction1792600000000 implements MigrationInterface {
  name = 'AddGuardrailAction1792600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "guardrail_spam_logs"
        ADD COLUMN IF NOT EXISTS "action" varchar(16)
    `);
    await queryRunner.query(`
      UPDATE "guardrail_spam_logs"
         SET "action" = 'log_only'
       WHERE "action" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "guardrail_spam_logs"
        DROP COLUMN IF EXISTS "action"
    `);
  }
}
