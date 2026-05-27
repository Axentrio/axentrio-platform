/**
 * Unit: Copilot cost / rate-limit middleware.
 *
 * Tests cover both individual limiters (daily-cap, per-minute
 * rate-limit) and the orchestrator (check-and-consume). Uses a
 * hand-rolled in-memory Redis fake — no ioredis-mock dependency.
 *
 * What this proves:
 *   - 51 calls in a day: 50 allowed, 51st throws with Retry-After
 *   - 11 calls in a minute: 10 allowed, 11th throws with Retry-After
 *   - Redis pipeline error → fail open (allowed=true, count=null)
 *   - MULTI/EXEC returns null (txn abort) → fail open
 *   - Per-command error inside the pipeline → fail open
 *   - Redis === null → fail open without throwing
 *   - Env var parsing rejects invalid values
 *   - Orchestrator preserves consumption order (daily then per-minute)
 *   - Orchestrator does NOT roll back the daily counter when the
 *     per-minute limiter rejects after (round 4 #5)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildDailyKey,
  checkAndConsumeDailyCap,
  CopilotDailyCapExceededError,
  getDailyCap,
  secondsUntilNextUtcMidnight,
} from '../../copilot/limits/daily-cap';
import {
  buildRateKey,
  checkAndConsumeRateLimit,
  CopilotRateLimitExceededError,
  getPerMinuteLimit,
} from '../../copilot/limits/rate-limit';
import { checkAndConsumeCopilotCost } from '../../copilot/limits/check-and-consume';

// ---------------------------------------------------------------
// In-memory Redis pipeline fake
// ---------------------------------------------------------------

interface PipelineSpy {
  incrCalls: string[];
  expireCalls: Array<[string, number]>;
  execCalls: number;
}

interface FakeRedisOptions {
  /** Make `pipeline.exec()` throw a raw error instead of resolving. */
  execThrows?: boolean;
  /** Make `pipeline.exec()` resolve to `null` (txn aborted by WATCH). */
  execReturnsNull?: boolean;
  /** Make the INCR command inside the pipeline return [Error, null]. */
  incrCommandErrors?: boolean;
  /** Make the EXPIRE command inside the pipeline return [Error, null]. */
  expireCommandErrors?: boolean;
  /** Force INCR to return a non-numeric value (corrupted result type). */
  incrReturnsNonNumeric?: boolean;
}

function makeFakeRedis(opts: FakeRedisOptions = {}): { redis: any; spy: PipelineSpy; store: Map<string, number> } {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();
  const spy: PipelineSpy = { incrCalls: [], expireCalls: [], execCalls: 0 };

  function buildPipeline() {
    const ops: Array<() => [Error | null, unknown]> = [];
    const pipeline: any = {
      incr(key: string) {
        spy.incrCalls.push(key);
        ops.push(() => {
          if (opts.incrCommandErrors) return [new Error('simulated INCR failure'), null];
          const next = (store.get(key) ?? 0) + 1;
          store.set(key, next);
          if (opts.incrReturnsNonNumeric) return [null, 'NaN'];
          return [null, next];
        });
        return pipeline;
      },
      expire(key: string, seconds: number) {
        spy.expireCalls.push([key, seconds]);
        ops.push(() => {
          if (opts.expireCommandErrors) return [new Error('simulated EXPIRE failure'), null];
          ttls.set(key, seconds);
          return [null, 1];
        });
        return pipeline;
      },
      async exec() {
        spy.execCalls++;
        if (opts.execThrows) throw new Error('simulated EXEC throw');
        if (opts.execReturnsNull) return null;
        return ops.map((op) => op());
      },
    };
    return pipeline;
  }

  const redis = {
    multi: buildPipeline,
  };
  return { redis, spy, store };
}

// ---------------------------------------------------------------
// daily-cap
// ---------------------------------------------------------------
describe('checkAndConsumeDailyCap', () => {
  it('builds the key as copilot:daily:{tenantId}:{YYYY-MM-DD} (UTC)', () => {
    const k = buildDailyKey('aaaa', new Date(Date.UTC(2026, 4, 26, 23, 30)));
    expect(k).toBe('copilot:daily:aaaa:2026-05-26');
  });

  it('allows the first 50 calls and rejects the 51st with Retry-After', async () => {
    const { redis } = makeFakeRedis();
    let lastResult: any;
    for (let i = 0; i < 50; i++) {
      lastResult = await checkAndConsumeDailyCap(redis, 'tenant-a', 50);
      expect(lastResult.allowed).toBe(true);
      expect(lastResult.count).toBe(i + 1);
    }
    const over = await checkAndConsumeDailyCap(redis, 'tenant-a', 50);
    expect(over.allowed).toBe(false);
    expect(over.count).toBe(51);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
    expect(over.retryAfterSeconds).toBeLessThanOrEqual(86_400);
  });

  it('uses MULTI/INCR/EXPIRE/EXEC pipeline with 90000s TTL', async () => {
    const { redis, spy } = makeFakeRedis();
    await checkAndConsumeDailyCap(redis, 'tenant-a', 50);
    expect(spy.incrCalls).toHaveLength(1);
    expect(spy.expireCalls).toHaveLength(1);
    expect(spy.execCalls).toBe(1);
    expect(spy.expireCalls[0][1]).toBe(90000);
  });

  it('falls open when redis is null', async () => {
    const r = await checkAndConsumeDailyCap(null, 'tenant-a', 50);
    expect(r).toEqual({ allowed: true, count: null, retryAfterSeconds: null });
  });

  it('falls open when exec() throws', async () => {
    const { redis } = makeFakeRedis({ execThrows: true });
    const r = await checkAndConsumeDailyCap(redis, 'tenant-a', 50);
    expect(r).toEqual({ allowed: true, count: null, retryAfterSeconds: null });
  });

  it('falls open when exec() returns null (txn aborted)', async () => {
    const { redis } = makeFakeRedis({ execReturnsNull: true });
    const r = await checkAndConsumeDailyCap(redis, 'tenant-a', 50);
    expect(r).toEqual({ allowed: true, count: null, retryAfterSeconds: null });
  });

  it('falls open when INCR returns an error inside the pipeline', async () => {
    const { redis } = makeFakeRedis({ incrCommandErrors: true });
    const r = await checkAndConsumeDailyCap(redis, 'tenant-a', 50);
    expect(r.allowed).toBe(true);
    expect(r.count).toBeNull();
  });

  it('falls open when EXPIRE returns an error inside the pipeline', async () => {
    const { redis } = makeFakeRedis({ expireCommandErrors: true });
    const r = await checkAndConsumeDailyCap(redis, 'tenant-a', 50);
    expect(r.allowed).toBe(true);
    expect(r.count).toBeNull();
  });

  it('falls open when INCR returns non-numeric (corrupted result type)', async () => {
    const { redis } = makeFakeRedis({ incrReturnsNonNumeric: true });
    const r = await checkAndConsumeDailyCap(redis, 'tenant-a', 50);
    expect(r.allowed).toBe(true);
    expect(r.count).toBeNull();
  });

  it('isolates counts per tenant', async () => {
    const { redis } = makeFakeRedis();
    await checkAndConsumeDailyCap(redis, 'tenant-a', 50);
    await checkAndConsumeDailyCap(redis, 'tenant-a', 50);
    const b = await checkAndConsumeDailyCap(redis, 'tenant-b', 50);
    expect(b.count).toBe(1);
  });

  it('Retry-After is seconds until next UTC midnight, NEVER negative', () => {
    expect(secondsUntilNextUtcMidnight(new Date(Date.UTC(2026, 4, 26, 23, 59, 59)))).toBe(1);
    expect(secondsUntilNextUtcMidnight(new Date(Date.UTC(2026, 4, 26, 0, 0, 0)))).toBe(86400);
  });
});

describe('getDailyCap env parsing', () => {
  const originalEnv = process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT;
    else process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT = originalEnv;
  });

  it('defaults to 50 when unset', () => {
    delete process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT;
    expect(getDailyCap()).toBe(50);
  });

  it('returns the parsed positive integer', () => {
    process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT = '125';
    expect(getDailyCap()).toBe(125);
  });

  it('throws on a non-integer value', () => {
    process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT = 'abc';
    expect(() => getDailyCap()).toThrow(/positive integer/);
  });

  it('throws on a zero / negative value', () => {
    process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT = '0';
    expect(() => getDailyCap()).toThrow(/positive integer/);
    process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT = '-3';
    expect(() => getDailyCap()).toThrow(/positive integer/);
  });
});

// ---------------------------------------------------------------
// per-minute rate-limit
// ---------------------------------------------------------------
describe('checkAndConsumeRateLimit', () => {
  it('builds the key as copilot:rl:{tenantId}:{userId}', () => {
    expect(buildRateKey('t1', 'u1')).toBe('copilot:rl:t1:u1');
  });

  it('allows the first 10 calls and rejects the 11th with Retry-After', async () => {
    const { redis } = makeFakeRedis();
    for (let i = 0; i < 10; i++) {
      const r = await checkAndConsumeRateLimit(redis, 'tenant-a', 'user-a', 10);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i + 1);
    }
    const over = await checkAndConsumeRateLimit(redis, 'tenant-a', 'user-a', 10);
    expect(over.allowed).toBe(false);
    expect(over.count).toBe(11);
    expect(over.retryAfterSeconds).toBe(60);
  });

  it('uses MULTI/INCR/EXPIRE/EXEC pipeline with 60s TTL', async () => {
    const { redis, spy } = makeFakeRedis();
    await checkAndConsumeRateLimit(redis, 'tenant-a', 'user-a', 10);
    expect(spy.incrCalls).toHaveLength(1);
    expect(spy.expireCalls).toHaveLength(1);
    expect(spy.expireCalls[0][1]).toBe(60);
  });

  it('falls open on every Redis failure mode', async () => {
    for (const opts of [
      { execThrows: true },
      { execReturnsNull: true },
      { incrCommandErrors: true },
      { expireCommandErrors: true },
      { incrReturnsNonNumeric: true },
    ]) {
      const { redis } = makeFakeRedis(opts);
      const r = await checkAndConsumeRateLimit(redis, 'tenant-a', 'user-a', 10);
      expect(r.allowed).toBe(true);
      expect(r.count).toBeNull();
    }
  });

  it('isolates counts per (tenant, user) pair', async () => {
    const { redis } = makeFakeRedis();
    await checkAndConsumeRateLimit(redis, 'tenant-a', 'user-a', 10);
    await checkAndConsumeRateLimit(redis, 'tenant-a', 'user-a', 10);
    const otherUser = await checkAndConsumeRateLimit(redis, 'tenant-a', 'user-b', 10);
    expect(otherUser.count).toBe(1);
    const otherTenant = await checkAndConsumeRateLimit(redis, 'tenant-b', 'user-a', 10);
    expect(otherTenant.count).toBe(1);
  });
});

describe('getPerMinuteLimit env parsing', () => {
  const originalEnv = process.env.COPILOT_PER_USER_PER_MINUTE_LIMIT;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.COPILOT_PER_USER_PER_MINUTE_LIMIT;
    else process.env.COPILOT_PER_USER_PER_MINUTE_LIMIT = originalEnv;
  });

  it('defaults to 10 when unset', () => {
    delete process.env.COPILOT_PER_USER_PER_MINUTE_LIMIT;
    expect(getPerMinuteLimit()).toBe(10);
  });

  it('returns the parsed positive integer', () => {
    process.env.COPILOT_PER_USER_PER_MINUTE_LIMIT = '7';
    expect(getPerMinuteLimit()).toBe(7);
  });

  it('throws on a non-integer / non-positive value', () => {
    process.env.COPILOT_PER_USER_PER_MINUTE_LIMIT = 'banana';
    expect(() => getPerMinuteLimit()).toThrow(/positive integer/);
    process.env.COPILOT_PER_USER_PER_MINUTE_LIMIT = '0';
    expect(() => getPerMinuteLimit()).toThrow(/positive integer/);
  });
});

// ---------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------
describe('checkAndConsumeCopilotCost (orchestrator)', () => {
  it('returns both counts when both limiters pass', async () => {
    const { redis } = makeFakeRedis();
    const r = await checkAndConsumeCopilotCost(redis, 'tenant-a', 'user-a', {
      dailyCap: 50,
      perMinuteLimit: 10,
    });
    expect(r).toEqual({ dailyCount: 1, rateLimitCount: 1 });
  });

  it('checks daily BEFORE per-minute (call order matters for failure mode)', async () => {
    const { redis, spy } = makeFakeRedis();
    await checkAndConsumeCopilotCost(redis, 'tenant-a', 'user-a', {
      dailyCap: 50,
      perMinuteLimit: 10,
    });
    expect(spy.incrCalls[0]).toMatch(/^copilot:daily:/);
    expect(spy.incrCalls[1]).toMatch(/^copilot:rl:/);
  });

  it('throws CopilotDailyCapExceededError when daily cap is over', async () => {
    const { redis } = makeFakeRedis();
    // Use a tiny cap to short-circuit.
    await checkAndConsumeCopilotCost(redis, 'tenant-a', 'user-a', {
      dailyCap: 1,
      perMinuteLimit: 999,
    });
    await expect(
      checkAndConsumeCopilotCost(redis, 'tenant-a', 'user-a', {
        dailyCap: 1,
        perMinuteLimit: 999,
      }),
    ).rejects.toBeInstanceOf(CopilotDailyCapExceededError);
  });

  it('throws CopilotRateLimitExceededError when per-minute is over', async () => {
    const { redis } = makeFakeRedis();
    // Daily cap very high, per-minute very low.
    await checkAndConsumeCopilotCost(redis, 'tenant-a', 'user-a', {
      dailyCap: 999,
      perMinuteLimit: 1,
    });
    await expect(
      checkAndConsumeCopilotCost(redis, 'tenant-a', 'user-a', {
        dailyCap: 999,
        perMinuteLimit: 1,
      }),
    ).rejects.toBeInstanceOf(CopilotRateLimitExceededError);
  });

  it('does NOT roll back the daily counter when the per-minute limiter rejects (round 4 #5)', async () => {
    const { redis, store } = makeFakeRedis();
    const dailyKey = buildDailyKey('tenant-a', new Date());

    // First call consumes 1 daily + 1 per-minute, both pass.
    await checkAndConsumeCopilotCost(redis, 'tenant-a', 'user-a', {
      dailyCap: 100,
      perMinuteLimit: 1,
    });
    expect(store.get(dailyKey)).toBe(1);

    // Second call: daily would have been allowed (under 100), but
    // per-minute is over (>=2 against limit 1). Counter IS still
    // consumed.
    await expect(
      checkAndConsumeCopilotCost(redis, 'tenant-a', 'user-a', {
        dailyCap: 100,
        perMinuteLimit: 1,
      }),
    ).rejects.toBeInstanceOf(CopilotRateLimitExceededError);
    expect(store.get(dailyKey)).toBe(2); // NOT rolled back to 1
  });

  it('falls open transparently when redis is null', async () => {
    const r = await checkAndConsumeCopilotCost(null, 'tenant-a', 'user-a', {
      dailyCap: 50,
      perMinuteLimit: 10,
    });
    expect(r).toEqual({ dailyCount: null, rateLimitCount: null });
  });
});

// ---------------------------------------------------------------
// Counter consumption is independent of agent-loop success (round 5 #1)
// ---------------------------------------------------------------
describe('counter consumption is independent of agent-loop outcome', () => {
  // The orchestrator runs BEFORE the agent loop. A failed turn never
  // even reaches a rollback path — the counter is already consumed.
  // This test asserts the orchestrator's behaviour stays constant
  // regardless of downstream success/failure.
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT;
    process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT = '3';
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT;
    else process.env.COPILOT_DAILY_MESSAGE_CAP_PER_TENANT = originalEnv;
  });

  it('three "accepted" requests use up the daily cap regardless of what the agent loop does', async () => {
    const { redis } = makeFakeRedis();
    // Simulate three accepted-by-limiter requests, then assert the
    // 4th is over the cap. The agent loop's outcome doesn't influence
    // the counter — only "is the request accepted by middleware."
    for (let i = 0; i < 3; i++) {
      const r = await checkAndConsumeCopilotCost(redis, 'tenant-a', 'user-a');
      expect(r.dailyCount).toBe(i + 1);
      // Simulated downstream failure: never reaches the rollback
      // path because there isn't one.
      try {
        throw new Error('simulated LLM 5xx');
      } catch {
        /* swallow — counter still consumed */
      }
    }
    await expect(
      checkAndConsumeCopilotCost(redis, 'tenant-a', 'user-a'),
    ).rejects.toBeInstanceOf(CopilotDailyCapExceededError);
  });
});

// Stop vitest complaining about unused import.
void vi;
