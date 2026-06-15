import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-template bots: a bot can bind up to 3 templates (ordered, [0]=primary),
 * combined in the composed prompt by `template_mode` ('or' = independent
 * specialities the AI self-selects; 'and' = one combined offering).
 *
 * `template_bindings` is the authoritative list; `template_id`/`template_version`
 * stay mirrored to the PRIMARY for back-compat with single-binding queries.
 * Backfill the new list from the existing single binding so live bots keep
 * resolving unchanged. Idempotent.
 */
export class AddBotTemplateBindings1786500000000 implements MigrationInterface {
  name = 'AddBotTemplateBindings1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_bots"
        ADD COLUMN IF NOT EXISTS "template_bindings" jsonb NOT NULL DEFAULT '[]'
    `);
    await queryRunner.query(`
      ALTER TABLE "chatbot_bots"
        ADD COLUMN IF NOT EXISTS "template_mode" varchar(8) NOT NULL DEFAULT 'or'
    `);
    // Backfill the binding list from the existing single binding (primary only).
    await queryRunner.query(`
      UPDATE "chatbot_bots"
         SET "template_bindings" = jsonb_build_array(
               jsonb_build_object('templateId', "template_id"::text, 'version', COALESCE("template_version", 'latest'))
             )
       WHERE "template_id" IS NOT NULL
         AND "template_bindings" = '[]'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chatbot_bots" DROP COLUMN IF EXISTS "template_bindings"`);
    await queryRunner.query(`ALTER TABLE "chatbot_bots" DROP COLUMN IF EXISTS "template_mode"`);
  }
}
