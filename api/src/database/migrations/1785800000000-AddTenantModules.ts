import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-tenant module enablement (entitlements/modules plan, Phase 2 step 9 —
 * .scratch/plan-entitlements-modules.md).
 *
 * One row = one enablement-gated (bespoke) Module switched on/configured for
 * one Tenant. Feature-gated modules (booking) NEVER need a row — activeness
 * comes from the entitlement resolver — so NO backfill is required and
 * existing tenants are behavior-identical with an empty table.
 *
 * module_id is varchar (not an enum) by design: the module catalog lives in
 * code and grows without migrations; unknown ids resolve inactive.
 *
 * CREATE TABLE IF NOT EXISTS so it is safe to (re-)run.
 */
export class AddTenantModules1785800000000 implements MigrationInterface {
  name = 'AddTenantModules1785800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenant_modules" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "module_id" varchar(100) NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "config" jsonb NOT NULL DEFAULT '{}',
        "reason" varchar(500),
        "set_by" varchar(255),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tenant_modules" PRIMARY KEY ("id"),
        CONSTRAINT "fk_tenant_modules_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_tenant_modules_tenant_module"
        ON "tenant_modules" ("tenant_id", "module_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant_modules"`);
  }
}
