import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stamp every EXISTING tenant as having finished onboarding.
 *
 * Onboarding cannot be skipped, and the check for "do they need it" is the absence of
 * `settings.onboarding`. Without this migration that check is true for every tenant
 * alive today, so on the deploy that ships the wizard every existing customer — people
 * who have been running bots and taking bookings for months — would be locked out of
 * their own workspace behind a setup flow asking for their VAT number.
 *
 * `grandfathered: true` records WHY the stamp is there. These tenants genuinely never
 * answered the questions, so a later "which customers gave us a verified company
 * number" must be able to tell them apart from someone who actually completed setup.
 * Their `company` is null for the same reason: inventing one from `tenants.name` would
 * put an unverified guess where a register-confirmed record is supposed to sit.
 *
 * Idempotent: only rows without the key are touched, so re-running cannot overwrite a
 * real onboarding record with a grandfather stamp.
 */
export class GrandfatherOnboarding1788400000000 implements MigrationInterface {
  name = 'GrandfatherOnboarding1788400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE tenants
         SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
               'onboarding', jsonb_build_object(
                 'version', 1,
                 'startedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'completedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'grandfathered', true,
                 'language', NULL,
                 'company', NULL,
                 'steps', '{}'::jsonb
               ))
       WHERE settings -> 'onboarding' IS NULL
    `);
  }

  /**
   * Removes ONLY the stamps this migration could have written. A tenant who genuinely
   * completed the wizard has `grandfathered` absent, and rolling back must not delete
   * their record and send them through setup a second time.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE tenants
         SET settings = settings - 'onboarding'
       WHERE settings -> 'onboarding' ->> 'grandfathered' = 'true'
    `);
  }
}
