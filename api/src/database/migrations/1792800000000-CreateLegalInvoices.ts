import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLegalInvoices1792800000000 implements MigrationInterface {
  name = 'CreateLegalInvoices1792800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "legal_invoices" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
        "document_kind" varchar(16) NOT NULL,
        "stripe_invoice_id" varchar(64),
        "stripe_refund_id" varchar(64),
        "stripe_customer_id" varchar(64),
        "stripe_subscription_id" varchar(64),
        "stripe_charge_id" varchar(64),
        "credited_from_id" uuid REFERENCES "legal_invoices"("id") ON DELETE SET NULL,
        "billit_order_id" varchar(32),
        "billit_invoice_number" varchar(64),
        "payment_status" varchar(16) NOT NULL,
        "invoice_status" varchar(24) NOT NULL,
        "peppol_status" varchar(24) NOT NULL,
        "peppol_required" boolean NOT NULL DEFAULT false,
        "currency" varchar(8) NOT NULL DEFAULT 'EUR',
        "amount_excl_cents" int NOT NULL DEFAULT 0,
        "vat_amount_cents" int NOT NULL DEFAULT 0,
        "amount_incl_cents" int NOT NULL DEFAULT 0,
        "review_reasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "last_error" text,
        "retry_count" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_legal_invoices_stripe_invoice"
        ON "legal_invoices" ("stripe_invoice_id")
        WHERE "document_kind" = 'invoice' AND "stripe_invoice_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_legal_invoices_stripe_refund"
        ON "legal_invoices" ("stripe_refund_id")
        WHERE "stripe_refund_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_legal_invoices_tenant_created"
        ON "legal_invoices" ("tenant_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "legal_invoices"`);
  }
}
