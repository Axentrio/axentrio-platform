import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bot-template tiers — group the template catalog into essential | pro |
 * enterprise. Fully ADDITIVE: one NOT NULL column with a default, so every
 * existing template lands in 'essential' and nothing else changes. Column name
 * mirrors the entity decorator so the prod migration and the test synchronize
 * agree.
 */
export class AddBotTemplateTier1787100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE bot_templates ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'essential'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE bot_templates DROP COLUMN IF EXISTS tier`);
  }
}
