import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Story 3 Enterprise — repeat-customer detection.
 *
 * `chatbot_leads` is one row per IDENTITY, so the same human on WhatsApp and then in
 * the widget owns two rows (`whatsapp:32475…` and `phone:32475…`). `person_key` is the
 * derived grouping key that spans them; the four `person_*` aggregates are the nightly
 * sweep's answer, cached on every row of the group so the leads list stays a single
 * indexed read instead of a per-row re-grouping of the tenant's whole lead table.
 *
 * Additive and NOT backfilled here, deliberately. The key is computed by
 * `computePersonKey()` in TypeScript — E.164 normalisation with an explicit refusal to
 * guess a country. Re-expressing that rule in SQL just to fill the column on deploy
 * would create a second implementation of the one decision in this feature that must
 * never drift, and a divergence between the two would merge people who are not the
 * same. `sweepRepeatCustomers` fills every row on its first run (it runs a minute after
 * boot) and recomputes from scratch on every run, so NULL is a transient state, not a
 * migration that has to be got right once.
 *
 * No CHECK constraints: `chatbot_leads` is populated, so any CHECK here would have to
 * be NOT VALID + a separate VALIDATE, and there is no invariant worth that — these
 * columns are a cache with one writer, and a wrong value is fixed by the next sweep.
 */
export class AddLeadPersonKey1788200000000 implements MigrationInterface {
  name = 'AddLeadPersonKey1788200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Same width as `dedupe_key`: the key can hold a full 320-char email plus prefix.
    await queryRunner.query(
      `ALTER TABLE "chatbot_leads" ADD COLUMN IF NOT EXISTS "person_key" varchar(400)`,
    );
    await queryRunner.query(
      `ALTER TABLE "chatbot_leads" ADD COLUMN IF NOT EXISTS "person_lead_count" int`,
    );
    await queryRunner.query(
      `ALTER TABLE "chatbot_leads" ADD COLUMN IF NOT EXISTS "person_conversation_count" int`,
    );
    await queryRunner.query(
      `ALTER TABLE "chatbot_leads" ADD COLUMN IF NOT EXISTS "person_first_seen_at" timestamptz`,
    );
    await queryRunner.query(
      `ALTER TABLE "chatbot_leads" ADD COLUMN IF NOT EXISTS "person_last_seen_at" timestamptz`,
    );

    // The sweep's grouping read, and the read the portal will use to pull a person's
    // other rows. Partial on the two conditions every consumer applies: a NULL key
    // groups with nothing, and an erased/expired row must never be grouped at all.
    // NOT unique — several rows per key is the whole point of the column.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "ix_chatbot_leads_person"
         ON "chatbot_leads" ("tenant_id", "person_key")
       WHERE "person_key" IS NOT NULL AND "deleted_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_chatbot_leads_person"`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP COLUMN IF EXISTS "person_last_seen_at"`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP COLUMN IF EXISTS "person_first_seen_at"`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP COLUMN IF EXISTS "person_conversation_count"`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP COLUMN IF EXISTS "person_lead_count"`);
    await queryRunner.query(`ALTER TABLE "chatbot_leads" DROP COLUMN IF EXISTS "person_key"`);
  }
}
