import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Leads-across-all-channels (.scratch/plan-leads-all-channels.md, step 1).
 *
 * The leads feature was structurally email-only: `email`/`name` NOT NULL and
 * dedup keyed on email — impossible for channel conversations (WhatsApp /
 * Messenger / Instagram / Telegram never provide an email). This migration
 * makes a Lead identity-polymorphic:
 *   - email + name become nullable
 *   - channel + external_user_id capture the channel identity
 *   - dedupe_key is the single per-identity upsert anchor (DB-unique, partial
 *     on not-deleted) — replacing the silent app-side email upsert
 *   - status supports the Leads-page triage filter (D9)
 *   - a CHECK guarantees every Lead has at least one contact identifier
 *
 * Risk-free on data: chatbot_leads has 0 rows, so nothing can violate the new
 * CHECK or unique index. All statements are IF (NOT) EXISTS-guarded so the
 * migration is safe to re-run.
 */
export class AddLeadIdentity1785900000000 implements MigrationInterface {
  name = 'AddLeadIdentity1785900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Relax the email-only requirement.
    await queryRunner.query(`ALTER TABLE "chatbot_leads" ALTER COLUMN "email" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" ALTER COLUMN "name" DROP NOT NULL`);

    // Channel identity + dedup anchor + triage status.
    await queryRunner.query(`ALTER TABLE "chatbot_leads" ADD COLUMN IF NOT EXISTS "channel" varchar(32)`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" ADD COLUMN IF NOT EXISTS "external_user_id" varchar(255)`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" ADD COLUMN IF NOT EXISTS "dedupe_key" varchar(400)`);
    await queryRunner.query(
      `ALTER TABLE "chatbot_leads" ADD COLUMN IF NOT EXISTS "status" varchar(32) NOT NULL DEFAULT 'new'`,
    );

    // Every Lead must be reachable by at least one identifier.
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_chatbot_leads_identity'
        ) THEN
          ALTER TABLE "chatbot_leads"
            ADD CONSTRAINT "chk_chatbot_leads_identity"
            CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL OR "external_user_id" IS NOT NULL);
        END IF;
      END $$;
    `);

    // Single per-identity upsert anchor — partial so a soft-deleted lead frees
    // its key (re-engaging an archived contact creates a fresh lead).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_chatbot_leads_tenant_dedupe"
        ON "chatbot_leads" ("tenant_id", "dedupe_key")
        WHERE "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ux_chatbot_leads_tenant_dedupe"`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP CONSTRAINT IF EXISTS "chk_chatbot_leads_identity"`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP COLUMN IF EXISTS "status"`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP COLUMN IF EXISTS "dedupe_key"`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP COLUMN IF EXISTS "external_user_id"`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP COLUMN IF EXISTS "channel"`);
    // NOTE: down does not re-impose NOT NULL on email/name — by the time this
    // runs there may be channel leads without email, which NOT NULL would
    // reject. Forward-only intent.
  }
}
