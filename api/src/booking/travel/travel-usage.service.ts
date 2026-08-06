/**
 * The spend guard for travel time — how much Google a Tenant has used this month, and
 * whether they may use any more.
 *
 * WHY THIS EXISTS BEFORE ANYTHING SPENDS. Travel time is the first capability on this
 * platform with a real per-use external cost, and cost is explicitly not a design driver
 * (correctness over cost, by founder decision). The cap is therefore not a budget: it is a
 * blast radius limit. One tenant with a runaway conversation loop, or an attacker feeding
 * unique addresses into a widget, must not be able to spend the platform's whole Maps
 * quota and take every other tenant's scheduler down with them.
 *
 * WHICH WAY IT FAILS. Exhausting the cap is NOT an outage and must not read as one. It
 * lands on the same branch as Routes being unreachable (ADR-0015): the haversine bounds
 * in `contracts/travel.ts` are PROOFS, so a spent tenant still refuses the slots that are
 * provably impossible and still confirms the ones that are provably fine, and only the
 * undecided middle band becomes a request. Degraded is strictly better than the flat gap
 * that shipped before this feature — it just never claims a verification it did not do.
 *
 * A METERING FAILURE READS AS EXHAUSTED. That is the opposite of the LLM budget check
 * next door, which fails open so a metering outage cannot silence the bot. The asymmetry
 * is deliberate: failing open there costs a conversation, failing open here spends real
 * money at an unknown rate with nothing counting it. And the closed direction is cheap
 * precisely because degraded mode is safe by construction.
 */
import { AppDataSource } from '../../database/data-source';
import { config } from '../../config/environment';
import { logger } from '../../utils/logger';

/**
 * First day of the current UTC calendar month, as `YYYY-MM-DD`.
 *
 * A calendar month rather than a rolling window because a spend guard has to be
 * explainable to whoever pays the bill, and the bill arrives monthly. UTC rather than the
 * business's timezone for the same reason — the bill is not in their timezone either.
 */
export function currentTravelPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Add `elements` billable Google units to this tenant's month.
 *
 * ELEMENTS, NOT CALLS. Route Matrix prices per origin×destination pair, so one request
 * covering three candidate slots costs three. Counting requests would undercount by
 * exactly the factor that varies.
 *
 * One statement, so two concurrent bookings cannot read-modify-write over each other —
 * the unique index on `(tenant_id, period_start)` is what makes the ON CONFLICT arm
 * reachable, and without it each would insert its own row and the total would silently
 * halve. Never throws: losing the count is bad, but failing the customer's booking because
 * the meter hiccuped is worse, and the next call re-reads the real stored total anyway.
 */
export async function recordTravelElements(tenantId: string, elements: number): Promise<void> {
  if (!Number.isFinite(elements) || elements <= 0) return;
  try {
    await AppDataSource.query(
      `INSERT INTO chatbot_travel_usage (tenant_id, period_start, elements)
       VALUES ($1, $2::date, $3)
       ON CONFLICT (tenant_id, period_start)
       DO UPDATE SET elements = chatbot_travel_usage.elements + EXCLUDED.elements,
                     updated_at = now()`,
      [tenantId, currentTravelPeriod(), Math.floor(elements)]
    );
  } catch (error) {
    logger.warn('[Travel] failed to record element usage', { tenantId, elements, error });
  }
}

/** Billable units this tenant has spent in the current month. */
export async function getTravelElementsUsed(tenantId: string): Promise<number> {
  const rows: Array<{ elements: number | string }> = await AppDataSource.query(
    `SELECT elements FROM chatbot_travel_usage WHERE tenant_id = $1 AND period_start = $2::date`,
    [tenantId, currentTravelPeriod()]
  );
  return Number(rows[0]?.elements ?? 0);
}

/**
 * Has this tenant spent its month? `true` means degrade per ADR-0015 — it does NOT mean
 * refuse the booking, and a caller that treats it as a refusal has inverted the feature.
 *
 * A cap of 0 or less means uncapped, matching how every other limit on this platform
 * degrades: a malformed limit must read as "no limit", never as "nothing allowed". This is
 * the only place that spelling appears, so a misconfigured env var cannot quietly disable
 * travel checks for every tenant at once.
 */
export async function isTravelSpendExhausted(tenantId: string): Promise<boolean> {
  const cap = config.travel.monthlyElementCapPerTenant;
  if (!Number.isFinite(cap) || cap <= 0) return false;
  try {
    return (await getTravelElementsUsed(tenantId)) >= cap;
  } catch (error) {
    // Fail CLOSED — see the header. Degraded mode is safe; unmetered spend is not.
    logger.warn('[Travel] spend check failed — treating the cap as exhausted', { tenantId, error });
    return true;
  }
}
