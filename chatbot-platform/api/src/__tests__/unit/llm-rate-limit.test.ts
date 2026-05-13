// api/src/__tests__/unit/llm-rate-limit.test.ts
//
// Exercises the per-tenant daily LLM rate limit helper directly.
// We inject a fake Redis client via the optional `deps` parameter so we can
// drive the INCR counter deterministically — no real Redis required.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkAndIncrement,
  resolveLimit,
  LlmRateLimitError,
} from '../../llm/llm-rate-limit';

/**
 * Minimal fake of the bits of ioredis we use: incr + expire.
 * `incr` returns the new value, mirroring the real Redis semantics.
 */
function makeFakeRedis(initial: Record<string, number> = {}) {
  const store: Record<string, number> = { ...initial };
  const expire = vi.fn(async (_key: string, _seconds: number) => 1);
  const incr = vi.fn(async (key: string) => {
    store[key] = (store[key] ?? 0) + 1;
    return store[key];
  });
  return { store, incr, expire } as const;
}

describe('checkAndIncrement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('under limit → allows the call and reports the new used count', async () => {
    const fake = makeFakeRedis();
    const result = await checkAndIncrement('tenant-1', 5, {
      // Cast — we only need the methods the helper actually calls.
      client: fake as any,
      available: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(5);
    expect(result.used).toBe(1);
    expect(fake.incr).toHaveBeenCalledOnce();
    // EXPIRE is set on the first hit so the counter resets ~24h later.
    expect(fake.expire).toHaveBeenCalledOnce();
    expect(fake.expire.mock.calls[0]![1]).toBe(86400);
  });

  it('does NOT re-set EXPIRE on subsequent increments', async () => {
    const fake = makeFakeRedis();
    await checkAndIncrement('tenant-1', 5, { client: fake as any, available: true });
    await checkAndIncrement('tenant-1', 5, { client: fake as any, available: true });
    await checkAndIncrement('tenant-1', 5, { client: fake as any, available: true });

    expect(fake.incr).toHaveBeenCalledTimes(3);
    // EXPIRE only on the first call (used === 1).
    expect(fake.expire).toHaveBeenCalledOnce();
  });

  it('at the limit (used === limit) → still allows; only blocks AFTER the cap', async () => {
    const fake = makeFakeRedis();
    // Fill counter exactly to the cap.
    for (let i = 0; i < 3; i++) {
      await checkAndIncrement('tenant-1', 3, { client: fake as any, available: true });
    }
    // The N-th call must NOT throw — we cap at N, so call N is allowed.
    // (Block happens at N+1.)
    expect(fake.incr).toHaveBeenCalledTimes(3);
  });

  it('over the limit (N+1 call) → throws LlmRateLimitError with limit + used', async () => {
    const fake = makeFakeRedis();
    // Consume the budget.
    for (let i = 0; i < 3; i++) {
      await checkAndIncrement('tenant-1', 3, { client: fake as any, available: true });
    }
    // The N+1 call should be blocked.
    let caught: unknown;
    try {
      await checkAndIncrement('tenant-1', 3, { client: fake as any, available: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmRateLimitError);
    const err = caught as LlmRateLimitError;
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('daily_llm_limit_reached');
    expect(err.limit).toBe(3);
    expect(err.used).toBe(4);
    // The response-body shape required by the spec.
    expect(err.toResponseBody()).toEqual({
      error: 'daily_llm_limit_reached',
      limit: 3,
      used: 4,
    });
  });

  it('Redis unavailable → fails open, allows the call without incrementing', async () => {
    const fake = makeFakeRedis();
    const result = await checkAndIncrement('tenant-1', 3, {
      client: fake as any,
      available: false, // simulate isRedisAvailable() === false
    });
    expect(result.allowed).toBe(true);
    expect(fake.incr).not.toHaveBeenCalled();
    expect(fake.expire).not.toHaveBeenCalled();
  });

  it('Redis client null → fails open (boot before Redis is initialized)', async () => {
    const result = await checkAndIncrement('tenant-1', 3, {
      client: null,
      available: true,
    });
    expect(result.allowed).toBe(true);
  });

  it('Redis throws on INCR → fails open, logs but does NOT block customer', async () => {
    const incr = vi.fn(async () => {
      throw new Error('connection reset by peer');
    });
    const expire = vi.fn();
    const result = await checkAndIncrement('tenant-1', 3, {
      client: { incr, expire } as any,
      available: true,
    });
    expect(result.allowed).toBe(true);
    expect(incr).toHaveBeenCalledOnce();
    expect(expire).not.toHaveBeenCalled();
  });

  it('per-tenant override beats the env default', async () => {
    const fake = makeFakeRedis();
    // Override of 1 means: first call OK, second call blocked.
    await checkAndIncrement('tenant-x', 1, { client: fake as any, available: true });
    await expect(
      checkAndIncrement('tenant-x', 1, { client: fake as any, available: true }),
    ).rejects.toBeInstanceOf(LlmRateLimitError);
  });
});

describe('resolveLimit', () => {
  it('uses override when > 0', () => {
    expect(resolveLimit(10)).toBe(10);
  });
  it('ignores override when null', () => {
    expect(typeof resolveLimit(null)).toBe('number');
    expect(resolveLimit(null)).toBeGreaterThan(0); // env default (5000 by default)
  });
  it('ignores override when undefined', () => {
    expect(resolveLimit(undefined)).toBeGreaterThan(0);
  });
  it('ignores zero / negative override (treated as unset)', () => {
    const def = resolveLimit(null);
    expect(resolveLimit(0)).toBe(def);
    expect(resolveLimit(-5)).toBe(def);
  });
});
