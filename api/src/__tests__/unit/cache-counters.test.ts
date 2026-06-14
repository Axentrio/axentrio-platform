// Version-counter helpers behind the templates availability fan-out
// (.scratch/plan-bot-templates.md T20). A global bump orphans every tenant's
// version-keyed cache entry at once; degrades to TTL-only when Redis is down.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ redis: null as null | { get: ReturnType<typeof vi.fn>; incr: ReturnType<typeof vi.fn> } }));
vi.mock('../../config/redis', () => ({ getRedisClient: () => state.redis }));

import { readCounter, bumpCounter } from '../../utils/cache';

describe('cache version counters', () => {
  beforeEach(() => { state.redis = null; });

  it('degrades gracefully when Redis is down (read → 0, bump → no-op)', async () => {
    expect(await readCounter('k')).toBe(0);
    await expect(bumpCounter('k')).resolves.toBeUndefined();
  });

  it('readCounter parses the stored value and bumpCounter INCRs', async () => {
    const store: Record<string, string> = { k: '4' };
    state.redis = {
      get: vi.fn(async (key: string) => store[key] ?? null),
      incr: vi.fn(async (key: string) => { store[key] = String((Number.parseInt(store[key] || '0', 10)) + 1); return Number.parseInt(store[key], 10); }),
    };
    expect(await readCounter('k')).toBe(4);
    await bumpCounter('k');
    expect(state.redis.incr).toHaveBeenCalledWith('k');
    expect(await readCounter('k')).toBe(5);
  });

  it('readCounter returns 0 for a missing key and never throws on Redis error', async () => {
    state.redis = { get: vi.fn(async () => null), incr: vi.fn() };
    expect(await readCounter('missing')).toBe(0);
    state.redis = { get: vi.fn(async () => { throw new Error('boom'); }), incr: vi.fn() };
    expect(await readCounter('k')).toBe(0);
  });
});
