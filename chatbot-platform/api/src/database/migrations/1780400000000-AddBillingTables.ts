import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBillingTables1780400000000 implements MigrationInterface {
  name = 'AddBillingTables1780400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Extend tenants_tier_enum with 'premium'.
    await queryRunner.query(
      `ALTER TYPE "tenants_tier_enum" ADD VALUE IF NOT EXISTS 'premium'`,
    );

    // tenant_billing_accounts
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenant_billing_accounts" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
        "provider" varchar(32) NOT NULL,
        "customer_id" varchar(255),
        "subscription_id" varchar(255),
        "status" varchar(32) NOT NULL,
        "current_plan_id" varchar(32) NOT NULL,
        "current_period_end" timestamptz,
        "cancel_at_period_end" boolean NOT NULL DEFAULT false,
        "pending_plan_id" varchar(32),
        "pending_plan_effective_at" timestamptz,
        "trial_end" timestamptz,
        "is_primary" boolean NOT NULL DEFAULT true,
        "billing_email" varchar(255),
        "raw_provider_data" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_tenant_billing_accounts_tenant_provider" UNIQUE ("tenant_id", "provider")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_billing_accounts_primary"
         ON "tenant_billing_accounts" ("tenant_id") WHERE "is_primary" = true`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_billing_accounts_provider_customer"
         ON "tenant_billing_accounts" ("provider", "customer_id") WHERE "customer_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_billing_accounts_provider_subscription"
         ON "tenant_billing_accounts" ("provider", "subscription_id") WHERE "subscription_id" IS NOT NULL`,
    );

    // billing_events
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing_events" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenant_id" uuid REFERENCES "tenants"("id") ON DELETE CASCADE,
        "provider" varchar(32) NOT NULL,
        "provider_event_id" varchar(255),
        "event_type" varchar(64) NOT NULL,
        "payload" jsonb NOT NULL,
        "raw_payload" jsonb,
        "processed_at" timestamptz NOT NULL DEFAULT now(),
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_events_provider_event"
         ON "billing_events" ("provider", "provider_event_id") WHERE "provider_event_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_events_tenant_created"
         ON "billing_events" ("tenant_id", "created_at" DESC)`,
    );

    // Backfill: one manual primary row per existing tenant, mirroring current tier.
    await queryRunner.query(`
      INSERT INTO "tenant_billing_accounts"
        ("tenant_id", "provider", "status", "current_plan_id", "is_primary")
      SELECT "id", 'manual', 'active', "tier"::text, true
      FROM "tenants"
      ON CONFLICT ("tenant_id", "provider") DO NOTHING
    `);
  }

  public async down(): Promise<void> {
    throw new Error(
      'AddBillingTables1780400000000 is irreversible by design. Shrinking tenants_tier_enum or dropping billing tables would corrupt promoted tenants and destroy audit history.',
    );
  }
}
