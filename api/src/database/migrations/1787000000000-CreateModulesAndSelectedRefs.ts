import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Composable-templates Phase 4 — authored Modules + a template's selected refs.
 *
 * Fully ADDITIVE: two new tables and one nullable column. No existing data is
 * touched; a template with selected_module_refs = NULL behaves exactly as before
 * (the resolver falls back to expectedModules). Column names mirror the entity
 * decorators (snake_case) so the prod migration and the test synchronize agree.
 */
export class CreateModulesAndSelectedRefs1787000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE modules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(200) NOT NULL,
        description VARCHAR(500),
        skill_ids JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE module_versions (
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
    await queryRunner.query(
      `CREATE UNIQUE INDEX ux_module_versions_module_version ON module_versions(module_id, version)`,
    );

    // Additive, nullable: shape [{ moduleId, moduleVersion }], snapshotted at the
    // template version's publish time. NULL = use the legacy expectedModules path.
    await queryRunner.query(
      `ALTER TABLE bot_template_versions ADD COLUMN selected_module_refs JSONB DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE bot_template_versions DROP COLUMN selected_module_refs`);
    await queryRunner.query(`DROP TABLE module_versions`);
    await queryRunner.query(`DROP TABLE modules`);
  }
}
