import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subscription/feature-access epic — M0 PR5.
 *
 * Adds `vat_id varchar(20) NULL` to `tenant_billing_accounts`. Allows
 * tenants to set/clear an EU VAT ID independently from a Stripe Customer,
 * which is then synced to Stripe Tax IDs (eu_vat) by the service layer.
 *
 * Format validation is permissive at our boundary (a regex that admits
 * any EU-shaped value); Stripe Tax does the canonical VIES check downstream.
 *
 * See .scratch/plan-m0-foundation-reshape.md § PR5 for the full spec.
 */
export class AddVatIdToTenantBillingAccount1782100000000 implements MigrationInterface {
  name = 'AddVatIdToTenantBillingAccount1782100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenant_billing_accounts" ADD COLUMN IF NOT EXISTS "vat_id" varchar(20)`,
    );
  }

  // -- DESTRUCTIVE: any VAT IDs stored after the up() migration ran will be
  // -- lost when this down() runs. Backup vat_id values manually before
  // -- rolling back in any environment with real data.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenant_billing_accounts" DROP COLUMN IF EXISTS "vat_id"`,
    );
  }
}
