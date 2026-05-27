import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-bot Phase 4 (#16d) — resync tenant.settings → anchor bot.settings
 * before the per-bot config flip.
 *
 * The 1782600 migration copied `tenant.settings #- '{ai,apiKey}'` into the
 * anchor bot at creation time. Since then, legacy code has continued writing
 * to `tenant.settings` while bot.settings has stayed at its 1782600 snapshot.
 * Without this resync, the #16d cutover would silently lose any settings
 * changes made in the interval.
 *
 * Strategy:
 *   - For each tenant with an anchor bot, recompute the moved slice from
 *     `tenant.settings #- '{ai,apiKey}'` and merge it on top of the existing
 *     `bot.settings`.
 *   - Latest-tenant-value wins on overlap — this is the safe direction
 *     because legacy writes were all hitting tenant.settings.
 *   - `ai.apiKey` is explicitly excluded (it's the only key that must stay
 *     tenant-scoped).
 *   - Idempotent: running twice produces the same end state.
 *   - Down(): no-op. Resynced bot.settings is the right state going forward;
 *     reverting would re-introduce drift.
 *
 * After this migration runs, the application code (PR for #16d) reads/writes
 * via bot.settings only.
 */
export class ResyncTenantSettingsToAnchorBot1782800000000 implements MigrationInterface {
  name = 'ResyncTenantSettingsToAnchorBot1782800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Single SQL: jsonb `#-` removes the apiKey path; outer `||` merges legacy
    // tenant settings ON TOP of existing bot settings so legacy writes win
    // overlapping keys. The result is reassigned to bot.settings.
    //
    // Scope: only the anchor bot (is_default=true) of each non-deleted tenant.
    // Non-anchor bots aren't touched — their settings were created with
    // `defaultBotSettings(name)` in the bot-create route and don't depend on
    // tenant.settings.
    const result = await queryRunner.query(`
      UPDATE chatbot_bots b
         SET settings = COALESCE(b.settings, '{}'::jsonb)
                      || (COALESCE(t.settings, '{}'::jsonb) #- '{ai,apiKey}'),
             updated_at = now()
        FROM tenants t
       WHERE b.tenant_id = t.id
         AND b.is_default = true
         AND b.deleted_at IS NULL
       RETURNING b.id
    `);

    // Postgres `RETURNING` shape via TypeORM raw-query: an array of rows.
    const updatedCount = Array.isArray(result) ? result.length : 0;
    // eslint-disable-next-line no-console
    console.log(`[1782800] Resynced tenant.settings → anchor bot.settings for ${updatedCount} tenants`);
  }

  public async down(): Promise<void> {
    // Intentional no-op. Reverting would re-introduce the tenant ↔ bot
    // settings drift this migration exists to close. If the application
    // code is rolled back to read from tenant.settings, the legacy data
    // is still there (we never deleted it from tenant.settings).
  }
}
