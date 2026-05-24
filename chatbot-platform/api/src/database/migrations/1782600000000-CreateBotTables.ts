import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-bot Phase 1 — introduce the `chatbot_bots` entity and backfill one
 * "anchor" bot per tenant from the tenant's existing single-bot config.
 *
 * Domain-prefixed table names (`chatbot_*`) avoid colliding with n8n's own
 * `agents`/builder tables in the shared `public` schema.
 *
 * Backfill is behaviour-neutral: the anchor's `public_key` equals the existing
 * `tenants.api_key`, and its `settings` is the tenant's settings minus the
 * tenant-level LLM secret (`ai.apiKey`). `chat_sessions.bot_id` is backfilled
 * to the anchor but kept NULLABLE (a later migration enforces NOT NULL).
 */
export class CreateBotTables1782600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Pre-backfill hygiene: every tenant needs a non-null api_key so the
    // anchor bot gets a valid, unique public_key. (api_key is already uniquely
    // indexed, so duplicates cannot exist.) Fail loudly rather than silently
    // skipping tenants.
    const nullKeys = await queryRunner.query(
      `SELECT count(*)::int AS count FROM tenants WHERE api_key IS NULL`
    );
    if (nullKeys[0].count > 0) {
      throw new Error(
        `CreateBotTables aborted: ${nullKeys[0].count} tenant(s) have a NULL api_key. ` +
        `Assign keys before running this migration.`
      );
    }

    // --- chatbot_bots ---
    await queryRunner.query(`
      CREATE TABLE chatbot_bots (
        id UUID NOT NULL DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        name VARCHAR(255) NOT NULL,
        public_key VARCHAR(255) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        is_default BOOLEAN NOT NULL DEFAULT false,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT "PK_chatbot_bots" PRIMARY KEY (id),
        CONSTRAINT "UQ_chatbot_bots_public_key" UNIQUE (public_key),
        CONSTRAINT "UQ_chatbot_bots_tenant_id" UNIQUE (tenant_id, id),
        CONSTRAINT "CHK_chatbot_bots_status" CHECK (status IN ('active', 'paused')),
        CONSTRAINT "FK_chatbot_bots_tenant" FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX idx_chatbot_bots_tenant_status ON chatbot_bots (tenant_id, status)`
    );
    // Exactly one non-deleted default (anchor) bot per tenant.
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_chatbot_bots_one_default
       ON chatbot_bots (tenant_id) WHERE is_default = true AND deleted_at IS NULL`
    );

    // --- chatbot_bot_knowledge_bases (join) ---
    await queryRunner.query(`
      CREATE TABLE chatbot_bot_knowledge_bases (
        bot_id UUID NOT NULL,
        knowledge_base_id UUID NOT NULL,
        tenant_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "PK_chatbot_bot_knowledge_bases" PRIMARY KEY (bot_id, knowledge_base_id),
        CONSTRAINT "FK_cbkb_bot" FOREIGN KEY (bot_id)
          REFERENCES chatbot_bots(id) ON DELETE CASCADE,
        CONSTRAINT "FK_cbkb_kb" FOREIGN KEY (knowledge_base_id)
          REFERENCES knowledge_bases(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_cbkb_kb ON chatbot_bot_knowledge_bases (knowledge_base_id)`
    );

    // --- chat_sessions.bot_id (nullable through Phase 1) ---
    await queryRunner.query(
      `ALTER TABLE chat_sessions ADD COLUMN bot_id UUID`
    );
    await queryRunner.query(
      `ALTER TABLE chat_sessions ADD CONSTRAINT "FK_chat_sessions_bot"
       FOREIGN KEY (bot_id) REFERENCES chatbot_bots(id)`
    );
    await queryRunner.query(
      `CREATE INDEX idx_chat_sessions_bot_id ON chat_sessions (bot_id)`
    );

    // --- Backfill: one anchor bot per tenant ---
    // public_key = api_key (so existing embeds resolve unchanged);
    // settings = tenant.settings minus the tenant-level LLM secret ai.apiKey.
    await queryRunner.query(`
      INSERT INTO chatbot_bots (tenant_id, name, public_key, status, is_default, settings)
      SELECT t.id, t.name, t.api_key, 'active', true,
             COALESCE(t.settings, '{}'::jsonb) #- '{ai,apiKey}'
      FROM tenants t
    `);

    // Backfill chat_sessions.bot_id → the tenant's anchor bot.
    await queryRunner.query(`
      UPDATE chat_sessions cs
      SET bot_id = b.id
      FROM chatbot_bots b
      WHERE b.tenant_id = cs.tenant_id AND b.is_default = true
    `);

    // Attach each tenant's existing KnowledgeBase(s) to its anchor bot.
    // (knowledge_bases uses camelCase column "tenantId".)
    await queryRunner.query(`
      INSERT INTO chatbot_bot_knowledge_bases (bot_id, knowledge_base_id, tenant_id)
      SELECT b.id, kb.id, kb."tenantId"
      FROM knowledge_bases kb
      JOIN chatbot_bots b ON b.tenant_id = kb."tenantId" AND b.is_default = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Pre-deploy/CI convenience only — see plan rollback policy. Dropping these
    // under live bot-aware code would break resolution and lose attribution.
    await queryRunner.query(`ALTER TABLE chat_sessions DROP COLUMN IF EXISTS bot_id`);
    await queryRunner.query(`DROP TABLE IF EXISTS chatbot_bot_knowledge_bases`);
    await queryRunner.query(`DROP TABLE IF EXISTS chatbot_bots`);
  }
}
