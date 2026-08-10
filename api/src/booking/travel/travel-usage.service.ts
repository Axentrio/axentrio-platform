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
 * in `contracts/travel.ts` still SPEAK, so a spent tenant still refuses the slots that are
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
 * Claim `elements` billable Google units for this tenant's month, or refuse.
 *
 * RESERVE BEFORE SPENDING, IN ONE STATEMENT, and that is what makes this a cap rather than
 * a hint. Asking "am I over?" and then counting afterwards leaves a window between the two
 * where every concurrent caller reads the same under-limit total and every one of them
 * proceeds, so the real ceiling becomes the cap plus however many requests happen to be in
 * flight. Here the check IS the increment: the `WHERE` on the conflict arm means Postgres
 * either counts the units and returns the new total, or matches nothing and returns no rows,
 * and no two callers can both win the last element.
 *
 * ELEMENTS, NOT CALLS. Route Matrix prices per origin×destination pair, so one request
 * covering three candidate slots costs three. Counting requests would undercount by exactly
 * the factor that varies. Reserved BEFORE the call rather than after, because Google bills
 * the request and not the answer, so a timeout costs the same as a hit.
 *
 * A METERING FAILURE REFUSES. See the header: degraded mode is safe by construction and
 * unmetered spend is not, which is the opposite of the LLM budget check next door.
 *
 * Returns `true` when the units are yours to spend.
 */
export async function reserveTravelElements(
  tenantId: string,
  elements: number,
): Promise<boolean> {
  // A genuine zero is a caller that wants nothing, and it proceeds having claimed nothing.
  if (elements === 0) return true;
  // EVERYTHING ELSE MUST BE A POSITIVE WHOLE NUMBER. A caller that cannot say how much it
  // wants does not get to spend. Negatives and fractions are called out because both would
  // otherwise read as "nothing to claim" and wave the request straight through: a negative
  // is obviously a bug, and a fraction floors to zero, which is the quieter version of one.
  if (!Number.isInteger(elements) || elements < 0) {
    logger.warn('[Travel] refusing a reservation for a nonsensical element count', { tenantId, elements });
    return false;
  }
  const n = elements;

  const cap = config.travel.monthlyElementCapPerTenant;
  // A malformed or absent limit reads as "no limit", matching every other ceiling on this
  // platform — a bad env var must never quietly disable travel for every tenant at once.
  const uncapped = !Number.isFinite(cap) || cap <= 0;
  // Guarded here as well as in SQL: the plain INSERT arm below is the first request of a
  // tenant's month and no `ON CONFLICT` clause can constrain it, so a single request larger
  // than the whole cap would otherwise sail through on the one day it is unopposed.
  if (!uncapped && n > cap) {
    logger.warn('[Travel] refusing a reservation larger than the whole monthly cap', { tenantId, elements: n, cap });
    return false;
  }

  try {
    const rows: unknown[] = await AppDataSource.query(
      `INSERT INTO chatbot_travel_usage (tenant_id, period_start, elements)
       VALUES ($1, $2::date, $3)
       ON CONFLICT (tenant_id, period_start)
       DO UPDATE SET elements = chatbot_travel_usage.elements + EXCLUDED.elements,
                     updated_at = now()
             WHERE $4::boolean OR chatbot_travel_usage.elements + EXCLUDED.elements <= $5
       RETURNING elements`,
      [tenantId, currentTravelPeriod(), n, uncapped, uncapped ? n : cap]
    );
    if (rows.length) return true;
    logger.warn('[Travel] monthly element cap reached', { tenantId, elements: n, cap });
    return false;
  } catch (error) {
    // Fail CLOSED. Losing the count is not the risk; spending real money at an unknown rate
    // with nothing counting it is.
    logger.warn('[Travel] could not reserve elements — refusing to spend', { tenantId, elements: n, error });
    return false;
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
 * THE QUESTION, NOT THE SPENDING. Anything about to call Google reserves through
 * `reserveTravelElements` instead, which is atomic; this exists for the callers that need
 * to know which branch they are on WITHOUT claiming an element — chiefly the degraded path,
 * which decides on the haversine bounds alone and spends nothing.
 *
 * A cap of 0 or less means uncapped, matching how every other limit on this platform
 * degrades: a malformed limit must read as "no limit", never as "nothing allowed".
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
