import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subscription/feature-access epic — M0 PR1.
 *
 * Tier remap: drop `premium`, add `essential`. Final enum:
 *   'free' | 'essential' | 'pro' | 'enterprise'
 *
 * Pre-launch (no production payers), so legacy `'premium'` rows are dev/staging
 * seed data. Remap `premium → enterprise` (closest to the old top tier's intent).
 * `'free'` stays as the internal-only cancellation terminal state (never UI-exposed).
 *
 * `tenant_billing_accounts.current_plan_id` and `pending_plan_id` are varchar(32),
 * NOT a Postgres enum — but they still hold plan-id strings that this migration
 * needs to keep in sync with the new canonical set.
 *
 * See .scratch/plan-m0-foundation-reshape.md § PR1 for the full rationale.
 */
export class RenamePlansEnumToEssentialPro1782000000000 implements MigrationInterface {
  name = 'RenamePlansEnumToEssentialPro1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pre-migration: informational counts. Pre-launch posture means production
    // should always see 0 here; logging it makes any surprise visible.
    await queryRunner.query(`
      DO $$
      BEGIN
        RAISE NOTICE 'Pre-migration premium-tier tenants: %',
          (SELECT COUNT(*) FROM tenants WHERE tier = 'premium');
        RAISE NOTICE 'Pre-migration premium-plan billing accounts: %',
          (SELECT COUNT(*) FROM tenant_billing_accounts
             WHERE current_plan_id = 'premium' OR pending_plan_id = 'premium');
      END $$;
    `);

    // 1. Remap any legacy 'premium' rows. Dev/staging only in practice.
    await queryRunner.query(`UPDATE tenants SET tier = 'enterprise' WHERE tier = 'premium'`);
    await queryRunner.query(`
      UPDATE tenant_billing_accounts SET current_plan_id = 'enterprise' WHERE current_plan_id = 'premium'
    `);
    await queryRunner.query(`
      UPDATE tenant_billing_accounts SET pending_plan_id = 'enterprise' WHERE pending_plan_id = 'premium'
    `);

    // 2. Defensive scrub: varchar columns can hold invalid legacy strings
    //    (empty string, wrong case, deleted plan names) that the enum migration
    //    in step 3 would not catch. Snap them to the safest defaults.
    await queryRunner.query(`
      UPDATE tenant_billing_accounts
        SET current_plan_id = 'free'
        WHERE current_plan_id IS NOT NULL
          AND current_plan_id NOT IN ('free', 'essential', 'pro', 'enterprise')
    `);
    await queryRunner.query(`
      UPDATE tenant_billing_accounts
        SET pending_plan_id = NULL
        WHERE pending_plan_id IS NOT NULL
          AND pending_plan_id NOT IN ('free', 'essential', 'pro', 'enterprise')
    `);

    // 3. Swap the tenants_tier_enum. Postgres can't DROP VALUE on an enum,
    //    so we create the new type, cast the column, drop the old type, rename.
    await queryRunner.query(`
      CREATE TYPE "tenants_tier_enum_new" AS ENUM ('free', 'essential', 'pro', 'enterprise')
    `);
    await queryRunner.query(`
      ALTER TABLE "tenants"
        ALTER COLUMN "tier" DROP DEFAULT,
        ALTER COLUMN "tier" TYPE "tenants_tier_enum_new"
          USING "tier"::text::"tenants_tier_enum_new",
        ALTER COLUMN "tier" SET DEFAULT 'free'
    `);
    await queryRunner.query(`DROP TYPE "tenants_tier_enum"`);
    await queryRunner.query(`ALTER TYPE "tenants_tier_enum_new" RENAME TO "tenants_tier_enum"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DESTRUCTIVE: Essential tenants get remapped to Pro because the legacy
    // enum has no Essential value. Any tenant moved to Essential between up()
    // and down() loses that distinction permanently.
    await queryRunner.query(`UPDATE tenants SET tier = 'pro' WHERE tier = 'essential'`);
    await queryRunner.query(`
      UPDATE tenant_billing_accounts SET current_plan_id = 'pro' WHERE current_plan_id = 'essential'
    `);
    await queryRunner.query(`
      UPDATE tenant_billing_accounts SET pending_plan_id = 'pro' WHERE pending_plan_id = 'essential'
    `);

    await queryRunner.query(`
      CREATE TYPE "tenants_tier_enum_old" AS ENUM ('free', 'pro', 'premium', 'enterprise')
    `);
    await queryRunner.query(`
      ALTER TABLE "tenants"
        ALTER COLUMN "tier" DROP DEFAULT,
        ALTER COLUMN "tier" TYPE "tenants_tier_enum_old"
          USING "tier"::text::"tenants_tier_enum_old",
        ALTER COLUMN "tier" SET DEFAULT 'free'
    `);
    await queryRunner.query(`DROP TYPE "tenants_tier_enum"`);
    await queryRunner.query(`ALTER TYPE "tenants_tier_enum_old" RENAME TO "tenants_tier_enum"`);
  }
}
