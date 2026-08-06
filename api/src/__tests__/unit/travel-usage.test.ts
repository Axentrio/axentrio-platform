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
  reserveTravelElements,
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

describe('reserveTravelElements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    travelConfig.monthlyElementCapPerTenant = 5000;
    dsQuery.mockResolvedValue([{ elements: 3 }]);
  });

  it('claims and checks in ONE statement, so no two callers win the last element', async () => {
    expect(await reserveTravelElements('ten-1', 3)).toBe(true);
    expect(dsQuery).toHaveBeenCalledOnce();
    const [sql, params] = dsQuery.mock.calls[0] as [string, unknown[]];
    // Asking "am I over?" and counting afterwards leaves a window in which every concurrent
    // caller reads the same under-limit total and all of them proceed. Here the check IS the
    // increment: Postgres either counts the units and returns a row, or matches nothing.
    expect(sql).toMatch(/ON CONFLICT \(tenant_id, period_start\)/);
    expect(sql).toMatch(/elements = chatbot_travel_usage\.elements \+ EXCLUDED\.elements/);
    expect(sql).toMatch(/WHERE .*chatbot_travel_usage\.elements \+ EXCLUDED\.elements <= /);
    expect(sql).toMatch(/RETURNING elements/);
    expect(params).toEqual(['ten-1', currentTravelPeriod(), 3, false, 5000]);
  });

  it('refuses when the statement matched nothing, which IS the cap being reached', async () => {
    dsQuery.mockResolvedValue([]);
    expect(await reserveTravelElements('ten-1', 1)).toBe(false);
  });

  it('refuses a single reservation bigger than the whole cap without querying', async () => {
    // The plain INSERT arm is a tenant's first request of the month and no ON CONFLICT
    // clause constrains it, so an oversized claim would sail through on that one day.
    expect(await reserveTravelElements('ten-1', 5001)).toBe(false);
    expect(dsQuery).not.toHaveBeenCalled();
  });

  it('treats a cap of zero as uncapped, never as nothing-allowed', async () => {
    travelConfig.monthlyElementCapPerTenant = 0;
    expect(await reserveTravelElements('ten-1', 999_999)).toBe(true);
    const [, params] = dsQuery.mock.calls[0] as [string, unknown[]];
    // The uncapped flag short-circuits the SQL condition rather than passing a huge ceiling.
    expect(params[3]).toBe(true);
  });

  it('claims nothing, and allows the caller through, when it wants nothing', async () => {
    expect(await reserveTravelElements('ten-1', 0)).toBe(true);
    expect(dsQuery).not.toHaveBeenCalled();
  });

  it('refuses a caller that cannot say how much it wants', async () => {
    // Bugs in the caller, all of them, and a buggy caller does not get to spend. A negative
    // would otherwise read as "nothing to claim" and wave the request straight through.
    expect(await reserveTravelElements('ten-1', -5)).toBe(false);
    expect(await reserveTravelElements('ten-1', Number.NaN)).toBe(false);
    expect(await reserveTravelElements('ten-1', Infinity)).toBe(false);
    // A fraction is the quiet version of the same bug: it floors to zero and would sail
    // through as "nothing to claim".
    expect(await reserveTravelElements('ten-1', 0.5)).toBe(false);
    expect(dsQuery).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the meter itself is unwritable', async () => {
    // Losing the count is not the risk. Spending real money at an unknown rate with nothing
    // counting it is, and refusing is safe because the degraded path still answers.
    dsQuery.mockRejectedValue(new Error('db down'));
    expect(await reserveTravelElements('ten-1', 1)).toBe(false);
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
