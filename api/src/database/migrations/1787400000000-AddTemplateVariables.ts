import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Template variables — custom {placeholders} a template version declares for
 * tenants to fill when they adopt it. Fully ADDITIVE: one nullable jsonb column.
 */
export class AddTemplateVariables1787400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE bot_template_versions ADD COLUMN IF NOT EXISTS variables JSONB`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE bot_template_versions DROP COLUMN IF EXISTS variables`);
  }
}
