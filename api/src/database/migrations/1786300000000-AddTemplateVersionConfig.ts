import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add identity/policy `config` to bot_template_versions (slim-down: tone + the
 * policy guardrails move from the per-bot AI settings into the template the bot
 * binds; .scratch/plan-bot-templates.md, codex-approved redesign).
 *
 * Empty `{}` is the default — effectiveBotConfig() falls back to the in-code
 * platform defaults for any absent field, so blank-base (config '{}') yields the
 * current platform defaults with no seed needed. Outlier bots (custom guardrails
 * ≠ defaults) are surfaced by the pre-deploy inventory script, not preserved.
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS). Mirrors entity BotTemplateVersion.config.
 */
export class AddTemplateVersionConfig1786300000000 implements MigrationInterface {
  name = 'AddTemplateVersionConfig1786300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bot_template_versions"
        ADD COLUMN IF NOT EXISTS "config" jsonb NOT NULL DEFAULT '{}'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bot_template_versions" DROP COLUMN IF EXISTS "config"`);
  }
}
