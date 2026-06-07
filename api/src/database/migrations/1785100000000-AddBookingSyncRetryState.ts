import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable retry/claim state for the Google-sync reconciliation worker (P0-4).
 *
 * - sync_attempts / sync_next_attempt_at / sync_last_error: backoff + terminal state.
 * - sync_claimed_until: a short lease so multiple replicas don't process the same
 *   pending row concurrently (claimed via FOR UPDATE SKIP LOCKED, IO outside the txn).
 *
 * Also neutralizes any EXISTING `sync_pending` rows: they were created before this
 * worker and may already have a Google event with a RANDOM id and no
 * BookingReference, so a deterministic-id create would duplicate. Mark them
 * terminal-manual instead, so the worker only ever sees post-deploy rows (which
 * all use deterministic ids and are safe to retry).
 */
export class AddBookingSyncRetryState1785100000000 implements MigrationInterface {
  name = 'AddBookingSyncRetryState1785100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_bookings
        ADD COLUMN IF NOT EXISTS sync_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS sync_next_attempt_at timestamptz,
        ADD COLUMN IF NOT EXISTS sync_last_error text,
        ADD COLUMN IF NOT EXISTS sync_claimed_until timestamptz
    `);
    await queryRunner.query(`
      UPDATE chatbot_bookings
         SET sync_pending = false,
             sync_last_error = 'legacy_pre_reconciler_manual',
             updated_at = now()
       WHERE sync_pending = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chatbot_bookings
        DROP COLUMN IF EXISTS sync_attempts,
        DROP COLUMN IF EXISTS sync_next_attempt_at,
        DROP COLUMN IF EXISTS sync_last_error,
        DROP COLUMN IF EXISTS sync_claimed_until
    `);
  }
}
