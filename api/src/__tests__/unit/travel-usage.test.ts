/**
 * The travel spend guard. The properties worth pinning are the ones a Redis counter would
 * have got wrong (durability, atomicity) and the fail DIRECTION, which is deliberately the
 * opposite of the LLM budget check next door.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const dsQuery = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
vi.mock('../../database/data-source', () => ({ AppDataSource: { query: (...a: unknown[]) => dsQuery(...a) } }));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { travelConfig } = vi.hoisted(() => ({ travelConfig: { monthlyElementCapPerTenant: 5000 } }));
vi.mock('../../config/environment', () => ({ config: { travel: travelConfig } }));

import {
  currentTravelPeriod,
  recordTravelElements,
  getTravelElementsUsed,
  isTravelSpendExhausted,
} from '../../booking/travel/travel-usage.service';

describe('currentTravelPeriod', () => {
  it('is the first day of the UTC calendar month', () => {
    expect(currentTravelPeriod(new Date('2026-08-31T23:30:00Z'))).toBe('2026-08-01');
    // A local wall-clock still in August, but already September in UTC, belongs to
    // September: the Google bill is not in the business's timezone either.
    expect(currentTravelPeriod(new Date('2026-08-31T23:30:00-04:00'))).toBe('2026-09-01');
  });

  it('zero-pads single-digit months', () => {
    expect(currentTravelPeriod(new Date('2026-01-15T12:00:00Z'))).toBe('2026-01-01');
  });
});

describe('recordTravelElements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dsQuery.mockResolvedValue([]);
  });

  it('increments in ONE statement rather than read-modify-write', async () => {
    await recordTravelElements('ten-1', 3);
    expect(dsQuery).toHaveBeenCalledOnce();
    const [sql, params] = dsQuery.mock.calls[0] as [string, unknown[]];
    // Two concurrent bookings must not lose an increment; the ON CONFLICT arm is what
    // makes that true, and it is only reachable because of the unique index.
    expect(sql).toMatch(/ON CONFLICT \(tenant_id, period_start\)/);
    expect(sql).toMatch(/elements = chatbot_travel_usage\.elements \+ EXCLUDED\.elements/);
    expect(params).toEqual(['ten-1', currentTravelPeriod(), 3]);
  });

  it('spends nothing on a zero, negative or non-finite count', async () => {
    await recordTravelElements('ten-1', 0);
    await recordTravelElements('ten-1', -5);
    await recordTravelElements('ten-1', Number.NaN);
    expect(dsQuery).not.toHaveBeenCalled();
  });

  it('never throws — a hiccuping meter must not fail the customer’s booking', async () => {
    dsQuery.mockRejectedValue(new Error('db down'));
    await expect(recordTravelElements('ten-1', 2)).resolves.toBeUndefined();
  });
});

describe('isTravelSpendExhausted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    travelConfig.monthlyElementCapPerTenant = 5000;
  });

  it('is false below the cap and true at it', async () => {
    dsQuery.mockResolvedValue([{ elements: 4999 }]);
    expect(await isTravelSpendExhausted('ten-1')).toBe(false);
    dsQuery.mockResolvedValue([{ elements: 5000 }]);
    expect(await isTravelSpendExhausted('ten-1')).toBe(true);
  });

  it('reads a tenant with no row as having spent nothing', async () => {
    dsQuery.mockResolvedValue([]);
    expect(await getTravelElementsUsed('ten-1')).toBe(0);
    expect(await isTravelSpendExhausted('ten-1')).toBe(false);
  });

  it('counts a numeric string, which is how pg returns some int columns', async () => {
    dsQuery.mockResolvedValue([{ elements: '5001' }]);
    expect(await getTravelElementsUsed('ten-1')).toBe(5001);
    expect(await isTravelSpendExhausted('ten-1')).toBe(true);
  });

  it('treats a cap of zero as uncapped, never as nothing-allowed', async () => {
    // Same degradation as every other limit on the platform: a malformed limit must read
    // as "no limit". Otherwise one bad env var silently stops travel checks everywhere.
    travelConfig.monthlyElementCapPerTenant = 0;
    dsQuery.mockResolvedValue([{ elements: 999999 }]);
    expect(await isTravelSpendExhausted('ten-1')).toBe(false);
    expect(dsQuery).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the meter itself is unreadable', async () => {
    // The opposite of the LLM budget check, on purpose: failing open there costs a
    // conversation, failing open here spends real money with nothing counting it. Safe
    // because "exhausted" degrades rather than refuses.
    dsQuery.mockRejectedValue(new Error('db down'));
    expect(await isTravelSpendExhausted('ten-1')).toBe(true);
  });
});
