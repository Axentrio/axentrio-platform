import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-bot Phase 4 (#16c) — enforce `chat_sessions.bot_id NOT NULL`.
 *
 * The 1782600 migration created the column nullable and backfilled existing
 * sessions to their tenant's anchor bot. Phase 4a (#16a `resolveBotKey`)
 * + Phase 4b (#16b paused-bot rejection) have been live since the previous
 * release — all new sessions are created with a resolved `botId`, and legacy
 * null sessions get bound on resume.
 *
 * This migration is the invariant lock-in. Strategy:
 *   1. Backfill any remaining null `bot_id` to the tenant's anchor bot.
 *      Defence in depth — should already be zero in production.
 *   2. SET NOT NULL on the column.
 *
 * Down(): reverts to nullable. The backfilled values stay (we never re-null
 * them), so rolling back is safe.
 */
export class ChatSessionsBotIdNotNull1782900000000 implements MigrationInterface {
  name = 'ChatSessionsBotIdNotNull1782900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Pre-migration log: how many null sessions exist?
    await queryRunner.query(`
      DO $$
      DECLARE
        null_count integer;
      BEGIN
        SELECT COUNT(*) INTO null_count FROM chat_sessions WHERE bot_id IS NULL;
        RAISE NOTICE 'Pre-migration null bot_id sessions: %', null_count;
      END $$;
    `);

    // 2. Backfill: bind each null-botId session to its tenant's anchor bot.
    //    Defence-in-depth — Phase 4a should have already covered new sessions
    //    + resume bindings, but this guarantees zero null rows before NOT NULL.
    await queryRunner.query(`
      UPDATE chat_sessions cs
         SET bot_id = b.id
        FROM chatbot_bots b
       WHERE cs.bot_id IS NULL
         AND b.tenant_id = cs.tenant_id
         AND b.is_default = true
         AND b.deleted_at IS NULL
    `);

    // 3. Hard guard: if any null bot_id rows remain (tenant with no anchor —
    //    should be impossible post-1782600), fail loudly before the constraint
    //    swap. Better to error here than to mid-migration FAIL on NOT NULL.
    const remaining: Array<{ count: string }> = await queryRunner.query(
      `SELECT COUNT(*)::text AS count FROM chat_sessions WHERE bot_id IS NULL`,
    );
    const remainingCount = parseInt(remaining[0]?.count ?? '0', 10);
    if (remainingCount > 0) {
      throw new Error(
        `Cannot enforce chat_sessions.bot_id NOT NULL: ${remainingCount} sessions still have NULL bot_id ` +
          `(tenants missing anchor bot). Run the anchor-bot backfill before retrying.`,
      );
    }

    // 4. Lock the invariant.
    await queryRunner.query(
      `ALTER TABLE chat_sessions ALTER COLUMN bot_id SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert to nullable. Existing values stay (we never re-null them).
    await queryRunner.query(
      `ALTER TABLE chat_sessions ALTER COLUMN bot_id DROP NOT NULL`,
    );
  }
}
