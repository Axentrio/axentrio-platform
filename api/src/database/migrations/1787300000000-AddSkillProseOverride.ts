import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-template prose overrides (composable-templates). A skill's default prose is
 * frozen in code; a template version may override it for itself via a
 * skillId→prose map. Fully ADDITIVE: one nullable jsonb column.
 */
export class AddSkillProseOverride1787300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE bot_template_versions ADD COLUMN IF NOT EXISTS skill_prose JSONB`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE bot_template_versions DROP COLUMN IF EXISTS skill_prose`);
  }
}
