import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Story 3 Enterprise — the human override for lead readiness.
 *
 * Only the OVERRIDE is stored. The score itself is computed on read from facts already
 * on the row (contact details, request, live booking, address), so it can never go stale
 * — a persisted score would silently keep counting a booking that was cancelled an hour
 * later, and nothing notifies the lead row when that happens.
 *
 * `readiness_override_by` / `_at` exist because this is a human judgement overriding a
 * machine one about a person: who changed it and when is the minimum needed to answer a
 * later question about why a lead was ranked the way it was.
 *
 * Additive only; no backfill (NULL means "not overridden", which is the correct state
 * for every existing row).
 */
export class AddLeadReadinessOverride1787700000000 implements MigrationInterface {
  name = 'AddLeadReadinessOverride1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chatbot_leads" ADD COLUMN IF NOT EXISTS "readiness_override" smallint`,
    );
    await queryRunner.query(
      `ALTER TABLE "chatbot_leads" ADD COLUMN IF NOT EXISTS "readiness_override_by" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "chatbot_leads" ADD COLUMN IF NOT EXISTS "readiness_override_at" timestamptz`,
    );
    // Range guard. Safe as a plain CHECK because the column is new and every existing
    // row is NULL — unlike a CHECK over populated data, which would need NOT VALID.
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_chatbot_leads_readiness_range') THEN
          ALTER TABLE "chatbot_leads"
            ADD CONSTRAINT "chk_chatbot_leads_readiness_range"
            CHECK ("readiness_override" IS NULL OR ("readiness_override" >= 0 AND "readiness_override" <= 100));
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chatbot_leads" DROP CONSTRAINT IF EXISTS "chk_chatbot_leads_readiness_range"`,
    );
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP COLUMN IF EXISTS "readiness_override_at"`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP COLUMN IF EXISTS "readiness_override_by"`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP COLUMN IF EXISTS "readiness_override"`);
  }
}
