import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retire the DB authored-module layer (composable-templates → module==skill, 1:1).
 * Prose is now frozen in code (tool-gated in the composer); templates bind skill
 * ids directly. DATA-SAFE: resolve each version's `selected_module_refs` → the
 * bound modules' `skill_ids` (unioned) BEFORE dropping the tables, so nothing is
 * lost. Supersedes 1787000000000 (which created the now-dropped tables).
 */
export class RetireAuthoredModules1787200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE bot_template_versions ADD COLUMN IF NOT EXISTS selected_skill_ids JSONB`);
    // Port existing bindings: each ref's moduleId → that module's skill_ids, unioned
    // per version. A deleted/missing module contributes nothing (JOIN drops it).
    await queryRunner.query(`
      UPDATE bot_template_versions v
      SET selected_skill_ids = sub.skills
      FROM (
        SELECT bv.id, jsonb_agg(DISTINCT sk.val) AS skills
        FROM bot_template_versions bv
        CROSS JOIN LATERAL jsonb_array_elements(bv.selected_module_refs) AS ref
        JOIN modules m ON m.id = (ref->>'moduleId')::uuid
        CROSS JOIN LATERAL jsonb_array_elements_text(m.skill_ids) AS sk(val)
        WHERE bv.selected_module_refs IS NOT NULL
          AND jsonb_typeof(bv.selected_module_refs) = 'array'
        GROUP BY bv.id
      ) sub
      WHERE v.id = sub.id
    `);
    await queryRunner.query(`ALTER TABLE bot_template_versions DROP COLUMN IF EXISTS selected_module_refs`);
    await queryRunner.query(`DROP TABLE IF EXISTS module_versions`);
    await queryRunner.query(`DROP TABLE IF EXISTS modules`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the schema shape (empty tables) so a rollback is well-formed.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS modules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(200) NOT NULL,
        description VARCHAR(500),
        skill_ids JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS module_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        module_id UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        version INT NOT NULL,
        prose TEXT NOT NULL DEFAULT '',
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        published_at TIMESTAMPTZ,
        published_by VARCHAR(255),
        lock_version INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`ALTER TABLE bot_template_versions ADD COLUMN IF NOT EXISTS selected_module_refs JSONB`);
    // NON-DESTRUCTIVE rollback: the up() UNION (module refs → skill ids) is not
    // reversible (the recreated modules table is empty), so we deliberately do NOT
    // drop selected_skill_ids — dropping it would permanently lose every template's
    // skill bindings. The column simply lingers after a down(); harmless, and the
    // data is preserved for a subsequent re-up().
  }
}
