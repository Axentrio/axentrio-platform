import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #148 — Account Information (invoice identity) on the Tenant.
 *
 * Distinct from Profile (Clerk user) and from the bot address (#153).
 * Official name / VAT / registered address already live in onboarding jsonb;
 * these columns are the durable, invoice-queryable home. Default-null so
 * existing tenants prefill from onboarding on first GET rather than being
 * forced through a backfill.
 */
export class AddAccountInformation1792100000000 implements MigrationInterface {
  name = 'AddAccountInformation1792100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenants"
        ADD COLUMN IF NOT EXISTS "official_business_name" varchar(255),
        ADD COLUMN IF NOT EXISTS "vat_number" varchar(16),
        ADD COLUMN IF NOT EXISTS "contact_person" varchar(255),
        ADD COLUMN IF NOT EXISTS "invoice_address" jsonb,
        ADD COLUMN IF NOT EXISTS "invoice_email" varchar(255),
        ADD COLUMN IF NOT EXISTS "account_phone" varchar(40),
        ADD COLUMN IF NOT EXISTS "vat_verified" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenants"
        DROP COLUMN IF EXISTS "official_business_name",
        DROP COLUMN IF EXISTS "vat_number",
        DROP COLUMN IF EXISTS "contact_person",
        DROP COLUMN IF EXISTS "invoice_address",
        DROP COLUMN IF EXISTS "invoice_email",
        DROP COLUMN IF EXISTS "account_phone",
        DROP COLUMN IF EXISTS "vat_verified"
    `);
  }
}
