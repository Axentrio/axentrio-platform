import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Blank means "no specialty identity", not "no capabilities" (#103).
 *
 * A template's skills were only ever its explicit selection, and `Blank (no template)` selects
 * nothing — so choosing a neutral-sounding, documented option silently removed booking, lead
 * capture and handoff. Measured on production 2026-08-13: of the three bots with bookable
 * services, two were on Blank and delivered no booking tools at all. One belonged to a paying
 * customer.
 *
 * Reading an empty selection as "everything" would have been the worse fix: a deliberately
 * knowledge-only template and a binding that has gone unavailable BOTH present an empty selection,
 * and both must stay tool-free. So the template states its intent instead.
 *
 * The policy lives on the TEMPLATE, not on a version, which is what makes this repair complete:
 * every bot bound to Blank is fixed by this migration alone, including bots pinned to an older
 * Blank version, and no per-bot rewrite is needed.
 *
 * Blank is also renamed. "Blank (no template)" describes the identity accurately and the
 * capabilities not at all, and it was the name that made the old behaviour look intended.
 */
export class TemplateSkillPolicy1791100000000 implements MigrationInterface {
  name = 'TemplateSkillPolicy1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Backfill `explicit` for everything that exists. Every current template curates its own
    // skills, and a template that has never heard of this column must never inherit.
    await queryRunner.query(`
      ALTER TABLE bot_templates
        ADD COLUMN IF NOT EXISTS skill_policy varchar(20) NOT NULL DEFAULT 'explicit'
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'chk_bot_templates_skill_policy'
             AND conrelid = 'bot_templates'::regclass
        ) THEN
          ALTER TABLE bot_templates
            ADD CONSTRAINT chk_bot_templates_skill_policy
            CHECK (skill_policy IN ('explicit', 'inherit_entitled', 'none'));
        END IF;
      END $$;
    `);

    // Repair Blank: keyed on `key`, which is the stable identifier, not the display name this
    // migration is about to change.
    await queryRunner.query(`
      UPDATE bot_templates
         SET skill_policy = 'inherit_entitled',
             display_name = 'General / Custom assistant',
             description  = 'No added specialty identity. Uses your instructions and every capability enabled for this bot.',
             updated_at   = NOW()
       WHERE key = 'blank-base'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE bot_templates
         SET display_name = 'Blank (no template)',
             description  = 'Neutral base with no added identity — the tenant''s own additional instructions drive the bot.',
             updated_at   = NOW()
       WHERE key = 'blank-base'
    `);
    await queryRunner.query(`
      ALTER TABLE bot_templates
        DROP CONSTRAINT IF EXISTS chk_bot_templates_skill_policy
    `);
    await queryRunner.query(`ALTER TABLE bot_templates DROP COLUMN IF EXISTS skill_policy`);
  }
}
