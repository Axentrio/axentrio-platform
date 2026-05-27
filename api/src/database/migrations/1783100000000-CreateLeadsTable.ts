import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M6 — first-class Leads table.
 *
 * Before this, leads were buried inside `chat_sessions.metadata.lead`
 * (jsonb blob, one per session). That meant the data was hard to query,
 * indexed only via the jsonb GIN scan, lost when a session was purged,
 * and unable to support a portal Leads inbox.
 *
 * `chatbot_leads` promotes leads to first-class. The session FK is
 * `ON DELETE SET NULL` so deleting a chat session doesn't take its
 * captured lead with it — leads outlive their source conversations.
 *
 * `chatbot_` prefix per the shared-schema rule (n8n shares this Postgres
 * `public` schema; unprefixed names risk silent collisions). Explicit
 * constraint names so they're recognisable in EXPLAIN output.
 *
 * The backfill from `chat_sessions.metadata.lead` lives in
 * `1783200000000-BackfillLeadsFromSessionMetadata` — separate migration
 * so the DDL is reversible without dragging data with it.
 */
export class CreateLeadsTable1783100000000 implements MigrationInterface {
  name = 'CreateLeadsTable1783100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_leads" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "session_id" uuid NULL,
        "bot_id" uuid NULL,
        "name" varchar(255) NOT NULL,
        "email" varchar(320) NOT NULL,
        "phone" varchar(64) NULL,
        "source" varchar(32) NOT NULL DEFAULT 'tool',
        "notes" text NULL,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz NULL,
        CONSTRAINT "pk_chatbot_leads" PRIMARY KEY ("id"),
        CONSTRAINT "fk_chatbot_leads_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_chatbot_leads_session"
          FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_chatbot_leads_bot"
          FOREIGN KEY ("bot_id") REFERENCES "chatbot_bots"("id") ON DELETE SET NULL
      )
    `);

    // Paginated list of a tenant's leads — newest first.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chatbot_leads_tenant_created"
        ON "chatbot_leads" ("tenant_id", "created_at" DESC)
        WHERE "deleted_at" IS NULL
    `);

    // Dedup checks ("does this tenant already have a lead with this email?").
    // NOT unique — same person can legitimately have multiple captures.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chatbot_leads_tenant_email"
        ON "chatbot_leads" ("tenant_id", "email")
        WHERE "deleted_at" IS NULL
    `);

    // Reverse lookup from a session — "what lead did this conversation capture?"
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chatbot_leads_session"
        ON "chatbot_leads" ("session_id")
        WHERE "session_id" IS NOT NULL AND "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_chatbot_leads_session"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_chatbot_leads_tenant_email"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_chatbot_leads_tenant_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_leads"`);
  }
}
