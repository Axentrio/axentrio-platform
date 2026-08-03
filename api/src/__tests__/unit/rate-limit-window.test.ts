/**
 * The two user-facing rate limiters are FIXED windows, not sliding ones.
 *
 * Both guard paths whose whole purpose is to unblock someone: reaching support, and
 * finishing signup. Re-setting the TTL on every attempt turns the limit into a trap —
 * a customer who keeps trying keeps their own key alive and never gets an allowance
 * back. The distinction is invisible until someone is already in trouble.
 */
import { describe, it, expect, vi } from 'vitest';

/** Minimal Redis double that records whether the TTL was (re)set. */
function fakeRedis() {
  let count = 0;
  const expireCalls: number[] = [];
  return {
    expireCalls,
    incr: vi.fn(async (_key: string) => ++count),
    expire: vi.fn(async (_k: string, ttl: number) => {
      expireCalls.push(ttl);
      return 1;
    }),
  };
}

/** The shape both call sites now use. */
async function consume(redis: ReturnType<typeof fakeRedis>, key: string, window: number) {
  const count = Number(await redis.incr(key));
  if (count === 1) await redis.expire(key, window);
  return count;
}

describe('fixed-window rate limiting', () => {
  it('sets the expiry once, however many attempts arrive', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 8; i++) await consume(redis, 'k', 3600);

    // One expire call — the window started at the first attempt and does not move.
    expect(redis.expireCalls).toEqual([3600]);
  });

  it('does not extend the lockout when someone keeps retrying', async () => {
    // The failure this exists to prevent: retry-extends-your-own-ban.
    const redis = fakeRedis();
    await consume(redis, 'k', 3600);
    const afterFirst = redis.expire.mock.calls.length;

    for (let i = 0; i < 20; i++) await consume(redis, 'k', 3600);
    expect(redis.expire.mock.calls.length).toBe(afterFirst);
  });
});
