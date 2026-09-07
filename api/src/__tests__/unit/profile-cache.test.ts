import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type * as ProfileService from '../../channels/meta/profile.service';

const axiosGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get: axiosGet }, get: axiosGet }));

const CACHE_TTL = 24 * 60 * 60 * 1000;

// Deliberate dynamic import (module-load boundary): fake timers must be
// installed BEFORE the module is evaluated, because the sweep is a
// module-level setInterval — a static import would register it on the real
// clock, before the test body runs, and it could never fire here.
let profileService: typeof ProfileService;

beforeAll(async () => {
  vi.useFakeTimers();
  profileService = await import('../../channels/meta/profile.service');
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  axiosGet.mockReset();
  axiosGet.mockResolvedValue({ data: { first_name: 'Ada', last_name: 'Lovelace', profile_pic: 'pic' } });
  profileService.__resetProfileCache();
});

describe('meta profile cache', () => {
  it('caches one entry per distinct user id', async () => {
    for (let i = 0; i < 5; i++) {
      await profileService.fetchMetaProfile(`psid-${i}`, 'token', 'messenger');
    }
    expect(profileService.__profileCacheSize()).toBe(5);
    expect(axiosGet).toHaveBeenCalledTimes(5);
  });

  it('serves a repeated id from cache without growing', async () => {
    await profileService.fetchMetaProfile('psid-0', 'token', 'messenger');
    const again = await profileService.fetchMetaProfile('psid-0', 'token', 'messenger');

    expect(again).toEqual({ displayName: 'Ada Lovelace', avatarUrl: 'pic' });
    expect(profileService.__profileCacheSize()).toBe(1);
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it('evicts expired entries without them being looked up again', async () => {
    for (let i = 0; i < 5; i++) {
      await profileService.fetchMetaProfile(`psid-${i}`, 'token', 'messenger');
    }
    expect(profileService.__profileCacheSize()).toBe(5);

    await vi.advanceTimersByTimeAsync(CACHE_TTL + 60_000);

    expect(profileService.__profileCacheSize()).toBe(0);
  });

  it('keeps entries that are still inside their TTL', async () => {
    await profileService.fetchMetaProfile('psid-live', 'token', 'messenger');

    await vi.advanceTimersByTimeAsync(60_000 * 5);

    expect(profileService.__profileCacheSize()).toBe(1);
  });
});
