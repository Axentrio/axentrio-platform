import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Super-admin bot templates — schema + blank-base seed
 * (.scratch/plan-bot-templates.md, Phase 1 step 3).
 *
 * Three tables (mirrors the entitlements/modules grant model):
 *   - bot_templates           — the versioned prompt IDENTITY + access scope
 *   - bot_template_versions   — immutable-once-published version bodies
 *   - tenant_bot_templates    — per-tenant grant rows (no row needed when the
 *                               template is availableToAllTenants)
 * plus two binding columns on chatbot_bots (template_id, template_version).
 *
 * Seeds the neutral `blank-base` template (availableToAllTenants, published v1,
 * empty body). Phase 2 binds every existing bot to it; behavior is unchanged
 * because an empty template body contributes nothing to the composed prompt.
 *
 * Idempotent (IF NOT EXISTS / ON CONFLICT) so it is safe to re-run.
 *
 * Shapes mirror entities/{BotTemplate,BotTemplateVersion,TenantBotTemplate}.ts
 * and the Bot column additions — tests build the schema from those entities via
 * synchronize (migrations do not run in test), so the two MUST stay in step.
 */
export class CreateBotTemplates1786100000000 implements MigrationInterface {
  name = 'CreateBotTemplates1786100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "bot_templates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "key" varchar(100) NOT NULL,
        "display_name" varchar(200) NOT NULL,
        "category" varchar(100),
        "description" text,
        "available_to_all_tenants" boolean NOT NULL DEFAULT false,
        "status" varchar(20) NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_bot_templates" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_bot_templates_key"
        ON "bot_templates" ("key")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "bot_template_versions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "template_id" uuid NOT NULL,
        "version" int NOT NULL,
        "body" text NOT NULL DEFAULT '',
        "changelog" varchar(500),
        "expected_modules" jsonb NOT NULL DEFAULT '[]',
        "status" varchar(20) NOT NULL DEFAULT 'draft',
        "published_at" timestamptz,
        "published_by" varchar(255),
        "lock_version" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_bot_template_versions" PRIMARY KEY ("id"),
        CONSTRAINT "fk_bot_template_versions_template" FOREIGN KEY ("template_id")
          REFERENCES "bot_templates"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_bot_template_versions_template_version"
        ON "bot_template_versions" ("template_id", "version")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenant_bot_templates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "template_id" uuid NOT NULL,
        "set_by" varchar(255),
        "set_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tenant_bot_templates" PRIMARY KEY ("id"),
        CONSTRAINT "fk_tenant_bot_templates_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_tenant_bot_templates_template" FOREIGN KEY ("template_id")
          REFERENCES "bot_templates"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_tenant_bot_templates_tenant_template"
        ON "tenant_bot_templates" ("tenant_id", "template_id")
    `);

    // Bot binding columns. Nullable template_id for now (Phase 2 backfills to
    // blank-base); template_version defaults to 'latest' (follow new publishes).
    await queryRunner.query(`
      ALTER TABLE "chatbot_bots"
        ADD COLUMN IF NOT EXISTS "template_id" uuid,
        ADD COLUMN IF NOT EXISTS "template_version" varchar(20) NOT NULL DEFAULT 'latest'
    `);

    // Seed blank-base (neutral, globally available, one published empty version).
    await queryRunner.query(`
      INSERT INTO "bot_templates" ("key", "display_name", "description", "available_to_all_tenants", "status")
      VALUES (
        'blank-base',
        'Blank (no template)',
        'Neutral base with no added identity — the tenant''s own additional instructions drive the bot.',
        true,
        'active'
      )
      ON CONFLICT ("key") DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "bot_template_versions" ("template_id", "version", "body", "status", "published_at", "published_by")
      SELECT "id", 1, '', 'published', now(), 'system'
      FROM "bot_templates" WHERE "key" = 'blank-base'
      ON CONFLICT ("template_id", "version") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_bots"
        DROP COLUMN IF EXISTS "template_version",
        DROP COLUMN IF EXISTS "template_id"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant_bot_templates"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "bot_template_versions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "bot_templates"`);
  }
}
