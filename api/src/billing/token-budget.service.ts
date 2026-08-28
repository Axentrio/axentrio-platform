import type { EntityManager } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { logger } from '../utils/logger';
import { returningRows } from '../utils/raw-sql';
import { getEntitlements } from './entitlements';
import { sendTokenBudgetWarning } from './token-budget-email';

export interface TokenBudgetSnapshot {
  allowanceTokens: number;
  topUpTokens: number;
  usedTokens: number;
  warnThreshold: number;
  hardStopThreshold: number;
  periodStart: Date;
  periodEnd: Date;
  unlimited: boolean;
}

type SqlRunner = {
  query: (sql: string, parameters?: unknown[]) => Promise<unknown>;
};

interface BalanceRow {
  id: string;
  period_used: string | number;
  top_up_balance: string | number;
  period_start: Date | string;
  period_end: Date | string;
}

function asNumber(value: string | number | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function subtractOneUtcMonth(d: Date): Date {
  const result = new Date(d.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - 1);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export function resolveBillingPeriod(
  currentPeriodEnd: Date | null,
  now: Date,
): { periodStart: Date; periodEnd: Date } {
  if (currentPeriodEnd && currentPeriodEnd.getTime() > now.getTime()) {
    const periodEnd = new Date(currentPeriodEnd.getTime());
    return { periodStart: subtractOneUtcMonth(periodEnd), periodEnd };
  }
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart, periodEnd };
}

export function tokenBudgetThresholds(
  allowanceTokens: number,
  topUpTokens: number,
): { warnThreshold: number; hardStopThreshold: number } {
  const pool = allowanceTokens + topUpTokens;
  return {
    warnThreshold: Math.floor(pool * 0.8),
    hardStopThreshold: Math.floor(pool * 1.1),
  };
}

async function currentPeriodEndFor(
  tenantId: string,
  db: SqlRunner,
): Promise<Date | null> {
  // pi-lens-ignore: ast-grep:no-sql-in-code
  const rows = (await db.query(
    `SELECT current_period_end
       FROM tenant_billing_accounts
      WHERE tenant_id = $1 AND is_primary = true
      LIMIT 1`,
    [tenantId],
  )) as Array<{ current_period_end: Date | string | null }>;
  const raw = rows[0]?.current_period_end;
  if (!raw) return null;
  const parsed = asDate(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function loadOrRollPeriod(
  tenantId: string,
  now: Date,
  allowanceTokens: number,
  db: SqlRunner = AppDataSource,
): Promise<BalanceRow> {
  const { periodStart, periodEnd } = resolveBillingPeriod(
    await currentPeriodEndFor(tenantId, db),
    now,
  );

  // pi-lens-ignore: ast-grep:no-sql-in-code
  await db.query(
    `INSERT INTO tenant_token_balance (tenant_id, period_start, period_end)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, periodStart, periodEnd],
  );

  // pi-lens-ignore: ast-grep:no-sql-in-code
  await db.query(
    `UPDATE tenant_token_balance
        SET top_up_balance = GREATEST(0, top_up_balance - GREATEST(0, period_used - $4)),
            period_used = 0,
            period_start = $2,
            period_end = $3,
            warned80_at = NULL,
            updated_at = now()
      WHERE tenant_id = $1 AND period_end <= $5
      RETURNING id`,
    [tenantId, periodStart, periodEnd, allowanceTokens, now],
  );

  // pi-lens-ignore: ast-grep:no-sql-in-code
  const rows = (await db.query(
    `SELECT id, period_used, top_up_balance, period_start, period_end
       FROM tenant_token_balance
      WHERE tenant_id = $1`,
    [tenantId],
  )) as BalanceRow[];
  const row = rows[0];
  if (!row) {
    throw new Error(`tenant_token_balance missing for ${tenantId}`);
  }
  return row;
}

function snapshotFrom(
  row: BalanceRow,
  allowanceTokens: number,
  unlimited: boolean,
): TokenBudgetSnapshot {
  const usedTokens = asNumber(row.period_used);
  const topUpTokens = asNumber(row.top_up_balance);
  const { warnThreshold, hardStopThreshold } = tokenBudgetThresholds(
    allowanceTokens,
    topUpTokens,
  );
  return {
    allowanceTokens,
    topUpTokens,
    usedTokens,
    warnThreshold,
    hardStopThreshold,
    periodStart: asDate(row.period_start),
    periodEnd: asDate(row.period_end),
    unlimited,
  };
}

export async function getTokenBudget(tenantId: string): Promise<TokenBudgetSnapshot> {
  const entitlements = await getEntitlements(tenantId);
  const monthlyTokens = entitlements.limits.monthlyTokens;
  const unlimited = monthlyTokens === null;
  const allowanceTokens = monthlyTokens ?? 0;
  const rollAllowance = monthlyTokens ?? Number.MAX_SAFE_INTEGER;
  const row = await loadOrRollPeriod(tenantId, new Date(), rollAllowance);
  return snapshotFrom(row, allowanceTokens, unlimited);
}

export async function isTokenBudgetExhausted(tenantId: string): Promise<boolean> {
  try {
    const entitlements = await getEntitlements(tenantId);
    if (entitlements.limits.monthlyTokens === null) return false;
    const allowanceTokens = entitlements.limits.monthlyTokens;
    const row = await loadOrRollPeriod(tenantId, new Date(), allowanceTokens);
    const usedTokens = asNumber(row.period_used);
    const topUpTokens = asNumber(row.top_up_balance);
    const { hardStopThreshold } = tokenBudgetThresholds(allowanceTokens, topUpTokens);
    return usedTokens > hardStopThreshold;
  } catch (error) {
    logger.warn('token_budget_check_failed', { tenantId, error });
    return false;
  }
}

export async function recordTokenUsage(
  tenantId: string,
  usage: { promptTokens: number; completionTokens: number },
): Promise<void> {
  try {
    const entitlements = await getEntitlements(tenantId);
    if (entitlements.limits.monthlyTokens === null) return;
    const total = usage.promptTokens + usage.completionTokens;
    if (!Number.isFinite(total) || total === 0) return;

    const allowanceTokens = entitlements.limits.monthlyTokens;
    await loadOrRollPeriod(tenantId, new Date(), allowanceTokens);

    // pi-lens-ignore: ast-grep:no-sql-in-code
    const incremented = returningRows<{
      id: string;
      period_used: string | number;
      previous: string | number;
      top_up_balance: string | number;
      period_start: Date | string;
      period_end: Date | string;
    }>(
      await AppDataSource.query(
        `UPDATE tenant_token_balance
            SET period_used = period_used + $2, updated_at = now()
          WHERE tenant_id = $1
          RETURNING id, period_used, period_used - $2 AS previous, top_up_balance, period_start, period_end`,
        [tenantId, total],
      ),
    );
    const row = incremented[0];
    if (!row) return;

    const usedTokens = asNumber(row.period_used);
    const previous = asNumber(row.previous);
    const topUpTokens = asNumber(row.top_up_balance);
    const { warnThreshold, hardStopThreshold } = tokenBudgetThresholds(
      allowanceTokens,
      topUpTokens,
    );
    if (!(previous < warnThreshold && usedTokens >= warnThreshold)) return;

    // pi-lens-ignore: ast-grep:no-sql-in-code
    const claimed = returningRows<{ id: string }>(
      await AppDataSource.query(
        `UPDATE tenant_token_balance SET warned80_at = now()
          WHERE tenant_id = $1 AND warned80_at IS NULL
          RETURNING id`,
        [tenantId],
      ),
    );
    if (claimed.length === 0) return;

    void sendTokenBudgetWarning(tenantId, row.id, {
      allowanceTokens,
      topUpTokens,
      usedTokens,
      warnThreshold,
      hardStopThreshold,
      periodStart: asDate(row.period_start),
      periodEnd: asDate(row.period_end),
      unlimited: false,
    }).catch((error) => {
      logger.warn('token_budget_warning_failed', { tenantId, error });
    });
  } catch (error) {
    logger.warn('token_budget_record_failed', { tenantId, error });
  }
}

export async function creditTokenTopUp(
  tenantId: string,
  tokens: number,
  manager: EntityManager,
): Promise<void> {
  const now = new Date();
  const { periodStart, periodEnd } = resolveBillingPeriod(
    await currentPeriodEndFor(tenantId, manager),
    now,
  );
  // pi-lens-ignore: ast-grep:no-sql-in-code
  await manager.query(
    `INSERT INTO tenant_token_balance (tenant_id, period_start, period_end, top_up_balance)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id) DO UPDATE
       SET top_up_balance = tenant_token_balance.top_up_balance + $4,
           updated_at = now()`,
    [tenantId, periodStart, periodEnd, tokens],
  );
}
