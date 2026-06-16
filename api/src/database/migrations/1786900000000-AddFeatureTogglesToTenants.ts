import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-tenant feature TOGGLES — the tenant's own on/off prefs for
 * entitlement-clamped features (.scratch/plan-feature-toggles-hardening.md, Fix A).
 *
 * Moves the prefs out of the shared `Tenant.settings` jsonb (where other
 * settings writers could clobber them, and the super-admin settings-merge could
 * bypass the validated write path) into a dedicated column, mirroring
 * `feature_overrides`. Each entry is keyed by a ToggleableFeatureKey → boolean;
 * absent key = on (when entitled). Empty object = no prefs (every existing tenant).
 *
 * Purely additive. ADD COLUMN IF NOT EXISTS so it is safe to (re-)run. The
 * backfill is guarded (`feature_toggles = '{}'`) so a re-run never overwrites a
 * newer column value — the stale `settings.featureToggles` sub-key is left in
 * place (harmless; the resolver no longer reads it).
 */
export class AddFeatureTogglesToTenants1786900000000 implements MigrationInterface {
  name = 'AddFeatureTogglesToTenants1786900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenants"
        ADD COLUMN IF NOT EXISTS "feature_toggles" jsonb NOT NULL DEFAULT '{}'
    `);
    await queryRunner.query(`
      UPDATE "tenants"
         SET "feature_toggles" = COALESCE("settings" -> 'featureToggles', '{}'::jsonb)
       WHERE "settings" ? 'featureToggles'
         AND "feature_toggles" = '{}'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenants" DROP COLUMN IF EXISTS "feature_toggles"
    `);
  }
}
