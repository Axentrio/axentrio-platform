import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-tenant feature overrides (entitlements/modules plan, Phase 1 step 1 —
 * .scratch/plan-entitlements-modules.md).
 *
 * Purely additive — one JSONB column on tenants. Each entry is keyed by a
 * FeatureKey and shaped { value, reason, setBy, setAt }; the entitlement
 * resolver merges entry.value over the plan-catalog features for billable
 * tenants. Empty object = no overrides (every existing tenant).
 *
 * ADD COLUMN IF NOT EXISTS so it is safe to (re-)run.
 */
export class AddFeatureOverridesToTenants1785700000000 implements MigrationInterface {
  name = 'AddFeatureOverridesToTenants1785700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenants"
        ADD COLUMN IF NOT EXISTS "feature_overrides" jsonb NOT NULL DEFAULT '{}'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenants" DROP COLUMN IF EXISTS "feature_overrides"
    `);
  }
}
