import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 3-day failed-renewal grace. First subscription payment failure stamps
 * `dunning_started_at`; the sweep emails daily then cancels at 72h.
 * Existing past_due rows stay NULL (grandfather — do not backfill).
 */
export class AddDunningStartedAt1795200000000 implements MigrationInterface {
  name = 'AddDunningStartedAt1795200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenant_billing_accounts" ADD COLUMN IF NOT EXISTS "dunning_started_at" TIMESTAMPTZ`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenant_billing_accounts" DROP COLUMN IF EXISTS "dunning_started_at"`,
    );
  }
}
