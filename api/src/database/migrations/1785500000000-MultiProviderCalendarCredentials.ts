import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P6b — make calendar credentials multi-provider (Google + Microsoft) but keep
 * AT MOST ONE active connection per bot.
 *
 * - Swap the active-credential unique index from `(bot_id, provider)` to
 *   `(bot_id)` (still `WHERE status='active'`), so a bot can have at most one
 *   active credential REGARDLESS of provider. Connecting a second provider must
 *   revoke the first (handled in app code, in-txn). The CREATE UNIQUE INDEX is
 *   itself the migration's "abort on real duplicates" guard: if any bot somehow
 *   had two active creds it would fail loudly rather than silently pick one —
 *   but none can exist today (only `provider='google'` rows, already uniqued on
 *   `(bot_id, provider)`), so the swap is safe.
 * - Add `account_id` (the provider's stable account identity — e.g. the
 *   Microsoft Graph user object id from `/me`; null for legacy Google rows) and
 *   `reauth_required` (owner must reconnect; cleared on reconnect).
 *
 * All steps are idempotent (IF [NOT] EXISTS) so a re-run / partial boot can't
 * crash-loop.
 */
export class MultiProviderCalendarCredentials1785500000000 implements MigrationInterface {
  name = 'MultiProviderCalendarCredentials1785500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_calendar_credentials
        ADD COLUMN IF NOT EXISTS account_id varchar(320),
        ADD COLUMN IF NOT EXISTS reauth_required boolean NOT NULL DEFAULT false
    `);
    // One active credential per bot, any provider.
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_chatbot_calendar_credentials_active"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_calendar_credentials_active_bot"
        ON "chatbot_calendar_credentials" ("bot_id")
        WHERE "status" = 'active'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_chatbot_calendar_credentials_active_bot"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatbot_calendar_credentials_active"
        ON "chatbot_calendar_credentials" ("bot_id", "provider")
        WHERE "status" = 'active'
    `);
    await queryRunner.query(`
      ALTER TABLE chatbot_calendar_credentials
        DROP COLUMN IF EXISTS reauth_required,
        DROP COLUMN IF EXISTS account_id
    `);
  }
}
