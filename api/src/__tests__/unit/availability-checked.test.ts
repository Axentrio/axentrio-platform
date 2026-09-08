import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
const mockRedis = {
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => {
    store.set(k, v);
    return 'OK';
  },
  del: async (k: string) => {
    store.delete(k);
    return 1;
  },
};
let redisAvailable = true;
vi.mock('../../config/redis', () => ({
  getRedisClient: () => (redisAvailable ? mockRedis : null),
}));

import {
  rememberAvailabilityChecked,
  peekAvailabilityChecked,
  availabilityCheckedFor,
} from '../../booking/booking-providers/availability-checked';

describe('availability-checked store', () => {
  beforeEach(() => {
    store.clear();
    redisAvailable = true;
  });

  it('records a 3-day range inclusively', async () => {
    await rememberAvailabilityChecked('sess-1', '2026-06-10', '2026-06-12');
    expect(await peekAvailabilityChecked('sess-1')).toEqual([
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
    ]);
  });

  it('ignores a malformed date', async () => {
    await rememberAvailabilityChecked('sess-1', 'nope', '2026-06-10');
    await rememberAvailabilityChecked('sess-1', '2026-06-10', '10-06-2026');
    expect(await peekAvailabilityChecked('sess-1')).toEqual([]);
  });

  it('clamps a 90-day range to 31 entries', async () => {
    await rememberAvailabilityChecked('sess-1', '2026-01-01', '2026-03-31');
    const dates = await peekAvailabilityChecked('sess-1');
    expect(dates).toHaveLength(31);
    expect(dates?.[0]).toBe('2026-01-01');
    expect(dates?.[30]).toBe('2026-01-31');
  });

  it('availabilityCheckedFor is false for an unrecorded date, true for a recorded one', async () => {
    await rememberAvailabilityChecked('sess-1', '2026-06-10', '2026-06-10');
    expect(await availabilityCheckedFor('sess-1', '2026-06-10')).toBe(true);
    expect(await availabilityCheckedFor('sess-1', '2026-06-11')).toBe(false);
  });

  it('with getRedisClient: () => null both readers return null', async () => {
    redisAvailable = false;
    expect(await peekAvailabilityChecked('sess-1')).toBeNull();
    expect(await availabilityCheckedFor('sess-1', '2026-06-10')).toBeNull();
  });
});
