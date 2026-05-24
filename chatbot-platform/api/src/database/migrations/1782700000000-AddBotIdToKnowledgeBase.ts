import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-bot Phase 3 — allow multiple KnowledgeBases per tenant.
 *
 * Adds a nullable `botId` to knowledge_bases and replaces the global
 * one-KB-per-tenant unique constraint with a PARTIAL unique index that keeps
 * exactly one tenant-primary KB (`botId IS NULL`) while allowing unlimited
 * bot-dedicated KBs (`botId` set). This preserves the legacy "the tenant's KB"
 * semantics (and its get-or-create race protection) without blocking per-bot
 * knowledge.
 *
 * knowledge_bases uses camelCase column names ("tenantId"), so the new column
 * is "botId" to match.
 */
export class AddBotIdToKnowledgeBase1782700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE knowledge_bases ADD COLUMN "botId" UUID`);
    await queryRunner.query(
      `ALTER TABLE knowledge_bases
         ADD CONSTRAINT "FK_knowledge_bases_bot"
         FOREIGN KEY ("botId") REFERENCES chatbot_bots(id) ON DELETE SET NULL`
    );

    // Drop the legacy auto-named UNIQUE constraint on ("tenantId") (created by
    // the entity's `@Column unique: true`). Its name is auto-generated, so look
    // it up rather than guess.
    await queryRunner.query(`
      DO $$
      DECLARE c text;
      BEGIN
        SELECT con.conname INTO c
        FROM pg_constraint con
        WHERE con.conrelid = 'knowledge_bases'::regclass
          AND con.contype = 'u'
          AND pg_get_constraintdef(con.oid) ILIKE '%(\"tenantId\")%';
        IF c IS NOT NULL THEN
          EXECUTE format('ALTER TABLE knowledge_bases DROP CONSTRAINT %I', c);
        END IF;
      END $$;
    `);

    // Exactly one tenant-primary (bot-less) KB per tenant; unlimited bot KBs.
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_knowledge_bases_tenant_primary
         ON knowledge_bases ("tenantId") WHERE "botId" IS NULL`
    );
    // General tenant lookup index (the old unique used to serve this).
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_bases_tenant ON knowledge_bases ("tenantId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_knowledge_bases_tenant`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_knowledge_bases_tenant_primary`);
    await queryRunner.query(`ALTER TABLE knowledge_bases DROP CONSTRAINT IF EXISTS "FK_knowledge_bases_bot"`);
    await queryRunner.query(`ALTER TABLE knowledge_bases DROP COLUMN IF EXISTS "botId"`);
    // Restore the global unique (only safe if no tenant has >1 KB).
    await queryRunner.query(
      `ALTER TABLE knowledge_bases ADD CONSTRAINT "UQ_knowledge_bases_tenantId" UNIQUE ("tenantId")`
    );
  }
}
