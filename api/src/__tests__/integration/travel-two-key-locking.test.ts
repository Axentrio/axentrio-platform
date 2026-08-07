/**
 * Two concurrent reschedules moving in opposite directions must not deadlock.
 *
 * A reschedule rewrites `calendar_key`, so a move can lift a booking off one itinerary and land
 * it on another — and #76 makes such a write assert the exposed first job on BOTH diaries, which
 * means holding both advisory locks. Two customers moving in opposite directions at the same
 * instant are then the classic lock-ordering deadlock, and Postgres resolves it by killing one
 * transaction with `40P01`.
 *
 * The fix is a total order on the keys, and it is one `.sort()` — which is exactly the kind of
 * line that gets removed by someone who cannot see what it is for. So this is tested against
 * REAL Postgres rather than a mock: a mocked lock cannot deadlock, and would therefore prove
 * that the sort is unnecessary.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';

const KEY_A = 'cal:aaaa-itinerary';
const KEY_B = 'cal:zzzz-itinerary';

/**
 * One transaction taking two advisory locks, with a pause between them wide enough that two
 * such transactions overlap for certain rather than by luck.
 */
async function takeBoth(keys: string[]): Promise<void> {
  await AppDataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [keys[0]]);
    await manager.query('SELECT pg_sleep(0.25)');
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [keys[1]]);
  });
}

describe('two-key advisory locking', () => {
  it('DEADLOCKS when the two keys are taken in opposite orders', async () => {
    // The failure this guards against, demonstrated rather than asserted from theory. Without
    // it, a reader has no evidence that the ordering below is load-bearing.
    const results = await Promise.allSettled([takeBoth([KEY_A, KEY_B]), takeBoth([KEY_B, KEY_A])]);

    const deadlocked = results.some(
      (r) => r.status === 'rejected' && String((r.reason as { code?: string })?.code) === '40P01'
    );
    expect(deadlocked).toBe(true);
  });

  it('does NOT deadlock when both take them in sorted order', async () => {
    // What the provider does: `[...new Set(keys)].sort()`. Both transactions therefore queue on
    // the same key first, and the second simply waits.
    const sorted = [KEY_A, KEY_B].sort();
    const results = await Promise.allSettled([takeBoth(sorted), takeBoth(sorted)]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('sorts to the same order whichever direction the move goes', async () => {
    // The property the provider relies on, stated directly: a move A→B and a move B→A produce
    // identical lock sequences, which is what makes the deadlock unreachable rather than rare.
    expect([...new Set([KEY_A, KEY_B])].sort()).toEqual([...new Set([KEY_B, KEY_A])].sort());
  });
});
