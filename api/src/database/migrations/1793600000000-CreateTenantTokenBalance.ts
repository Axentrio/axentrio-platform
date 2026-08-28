import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTenantTokenBalance1793600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "tenant_token_balance" (
        "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
        "tenant_id" uuid NOT NULL,
        "period_start" timestamptz NOT NULL,
        "period_end" timestamptz NOT NULL,
        "period_used" bigint NOT NULL DEFAULT 0,
        "top_up_balance" bigint NOT NULL DEFAULT 0,
        "warned80_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tenant_token_balance" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_tenant_token_balance_tenant" UNIQUE ("tenant_id"),
        CONSTRAINT "FK_tenant_token_balance_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "tenants" ADD COLUMN "monthly_token_limit" integer
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenants" DROP COLUMN IF EXISTS "monthly_token_limit"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant_token_balance"`);
  }
}
