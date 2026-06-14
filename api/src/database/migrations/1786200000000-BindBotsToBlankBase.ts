import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bind every existing bot to the neutral `blank-base` template
 * (.scratch/plan-bot-templates.md, Phase 2 step 8).
 *
 * Behavior is unchanged: blank-base's published body is empty, so the composed
 * prompt's template layer (layer 2) contributes nothing — existing bots keep
 * their current customInstructions-driven prompt exactly. The binding just makes
 * the relationship explicit (and `template_version` already defaults to 'latest',
 * so these bots follow future publishes once a real template is selected).
 *
 * Idempotent: only binds bots that are still unbound (template_id IS NULL).
 * If blank-base is somehow absent the subquery yields NULL and this is a no-op.
 */
export class BindBotsToBlankBase1786200000000 implements MigrationInterface {
  name = 'BindBotsToBlankBase1786200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "chatbot_bots"
         SET "template_id" = (SELECT "id" FROM "bot_templates" WHERE "key" = 'blank-base')
       WHERE "template_id" IS NULL
         AND (SELECT "id" FROM "bot_templates" WHERE "key" = 'blank-base') IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "chatbot_bots"
         SET "template_id" = NULL
       WHERE "template_id" = (SELECT "id" FROM "bot_templates" WHERE "key" = 'blank-base')
    `);
  }
}
