import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill shared-knowledge attachments for multi-bot config editing.
 *
 * Runtime RAG retrieves only from a bot's attached KnowledgeBases. Bots created
 * before this slice (and anchors whose primary KB was lazy-created after the
 * 1782600 cutover) may have no attachment to the tenant's primary KB
 * (`"botId" IS NULL`), so they answer from nothing. This ensures:
 *   1. every tenant that has a bot has a primary KB, and
 *   2. every non-deleted bot (anchor + non-anchor) is attached to it.
 *
 * Existing per-bot dedicated KBs are left untouched. Idempotent and safe to
 * re-run (NOT EXISTS guards + targetless ON CONFLICT DO NOTHING).
 */
export class BackfillSharedKbAttachments1784700000000 implements MigrationInterface {
  name = 'BackfillSharedKbAttachments1784700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create a primary (bot-less) KB for any tenant that has a bot but no
    //    primary KB yet. `status` is intentionally omitted so the column default
    //    applies — its type differs across environments (varchar in the prod
    //    migration, enum where the schema was synchronized), and a text literal
    //    won't coerce to the enum. `botId` is cast to uuid (a bare NULL is text).
    await queryRunner.query(`
      INSERT INTO knowledge_bases ("tenantId", "botId")
      SELECT DISTINCT b.tenant_id, NULL::uuid
      FROM chatbot_bots b
      WHERE b.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_bases kb
          WHERE kb."tenantId" = b.tenant_id AND kb."botId" IS NULL
        )
      ON CONFLICT DO NOTHING
    `);

    // 2. Attach each tenant's primary KB to every non-deleted bot missing it.
    await queryRunner.query(`
      INSERT INTO chatbot_bot_knowledge_bases (bot_id, knowledge_base_id, tenant_id)
      SELECT b.id, kb.id, b.tenant_id
      FROM chatbot_bots b
      JOIN knowledge_bases kb
        ON kb."tenantId" = b.tenant_id AND kb."botId" IS NULL
      WHERE b.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM chatbot_bot_knowledge_bases j
          WHERE j.bot_id = b.id AND j.knowledge_base_id = kb.id
        )
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(): Promise<void> {
    // No-op: this backfill is additive and we cannot distinguish attachments it
    // created from ones that already existed. Detaching would risk removing
    // intentional links. Reversal is intentionally not supported.
  }
}
