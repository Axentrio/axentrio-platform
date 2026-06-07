/**
 * Boot-safety guard for AddBookingSyncRetryState: runs up() against the real test
 * DB so a SQL typo can't crash-loop prod on boot. Idempotent (ADD COLUMN IF NOT
 * EXISTS). down() is NOT exercised — it drops columns the synchronized schema
 * needs for other tests in this worker.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { AddBookingSyncRetryState1785100000000 } from '../../database/migrations/1785100000000-AddBookingSyncRetryState';

describe('AddBookingSyncRetryState migration', () => {
  it('up() runs without error and is idempotent', async () => {
    const m = new AddBookingSyncRetryState1785100000000();
    const qr = AppDataSource.createQueryRunner();
    try {
      await qr.connect();
      await m.up(qr);
      await m.up(qr);
    } finally {
      await qr.release();
    }

    const cols: Array<{ column_name: string }> = await AppDataSource.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'chatbot_bookings'
          AND column_name IN ('sync_attempts','sync_next_attempt_at','sync_last_error','sync_claimed_until')`
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual([
      'sync_attempts',
      'sync_claimed_until',
      'sync_last_error',
      'sync_next_attempt_at',
    ]);
  });
});
