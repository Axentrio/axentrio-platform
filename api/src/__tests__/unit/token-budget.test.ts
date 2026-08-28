import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('../../database/data-source', () => ({
  AppDataSource: { query: (...args: unknown[]) => query(...args) },
}));

vi.mock('../../billing/token-budget-email', () => ({
  sendTokenBudgetWarning: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../billing/entitlements', async (importOriginal) => {
  const actual = await importOriginal();
  return Object.assign({}, actual as object, { getEntitlements: vi.fn() });
});

import { getEntitlements, entitlementsFor } from '../../billing/entitlements';
import { isTokenBudgetExhausted, resolveBillingPeriod } from '../../billing/token-budget.service';

const getEntitlementsMock = vi.mocked(getEntitlements);

function entitlementsWithMonthlyTokens(monthlyTokens: number | null) {
  const base = entitlementsFor('essential');
  return {
    ...base,
    limits: { ...base.limits, monthlyTokens },
  };
}

function stubBalance(periodUsed: number, topUpBalance: number): void {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('tenant_billing_accounts')) return [];
    if (sql.includes('INSERT INTO tenant_token_balance')) return [];
    if (sql.includes('period_end <=')) return [];
    if (sql.includes('SELECT id, period_used')) {
      return [
        {
          id: 'bal-1',
          period_used: String(periodUsed),
          top_up_balance: String(topUpBalance),
          period_start: new Date('2026-04-01T00:00:00Z'),
          period_end: new Date('2026-05-01T00:00:00Z'),
        },
      ];
    }
    return [];
  });
}

describe('resolveBillingPeriod', () => {
  it('uses a future currentPeriodEnd and a start one calendar month earlier', () => {
    const now = new Date('2026-04-10T12:00:00Z');
    const currentPeriodEnd = new Date('2026-06-15T00:00:00Z');
    const period = resolveBillingPeriod(currentPeriodEnd, now);
    expect(period.periodEnd.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(period.periodStart.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });

  it('falls back to the current UTC calendar month when currentPeriodEnd is null', () => {
    const now = new Date('2026-04-10T12:00:00Z');
    const period = resolveBillingPeriod(null, now);
    expect(period.periodStart.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(period.periodEnd.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('isTokenBudgetExhausted', () => {
  beforeEach(() => {
    query.mockReset();
    getEntitlementsMock.mockReset();
  });

  it('is false at the essential grace boundary and true one token past it', async () => {
    getEntitlementsMock.mockResolvedValue(entitlementsWithMonthlyTokens(5_000_000));
    stubBalance(5_500_000, 0);
    expect(await isTokenBudgetExhausted('t1')).toBe(false);

    stubBalance(5_500_001, 0);
    expect(await isTokenBudgetExhausted('t1')).toBe(true);
  });

  it('returns false and issues no query when monthlyTokens is null', async () => {
    getEntitlementsMock.mockResolvedValue(entitlementsWithMonthlyTokens(null));
    expect(await isTokenBudgetExhausted('t1')).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('fails open when the database throws', async () => {
    getEntitlementsMock.mockResolvedValue(entitlementsWithMonthlyTokens(5_000_000));
    query.mockRejectedValue(new Error('db down'));
    expect(await isTokenBudgetExhausted('t1')).toBe(false);
  });

  it('raises the hard-stop ceiling by the top-up balance', async () => {
    getEntitlementsMock.mockResolvedValue(entitlementsWithMonthlyTokens(5_000_000));
    stubBalance(11_000_000, 5_000_000);
    expect(await isTokenBudgetExhausted('t1')).toBe(false);

    stubBalance(11_000_001, 5_000_000);
    expect(await isTokenBudgetExhausted('t1')).toBe(true);
  });
});
