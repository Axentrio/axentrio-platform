/**
 * What grouping is allowed to spend (#81).
 *
 * Grouping and feasibility draw on ONE monthly element counter, and they are not equals.
 * Feasibility answers whether a booking is possible at all; grouping only makes a correct answer
 * nicer. So an unbounded scorer could spend a tenant's month and leave the gate unable to measure
 * a drive - which turns confirmable slots into Requests, exactly what ADR-0017 forbids grouping
 * from causing. The optional thing must run out first, by construction rather than by care.
 *
 * Two independent limits, because they fail differently. Elements are money and are counted
 * monthly; the deadline is a customer waiting for slots right now, and no element budget bounds
 * how long a slow upstream takes to answer.
 */
import { reserveTravelElements } from './travel-usage.service';
import { logger } from '../../utils/logger';

/**
 * The share of a tenant's monthly cap grouping may reach.
 *
 * At 0.3 the scorer stops once total spend passes 30% and feasibility keeps at least 70% for the
 * rest of the month, whoever spent it. Chosen rather than derived: the honest position is that
 * nobody knows the right split until LP4 has measured real element cost, and that measurement is
 * what this phase exists for. It is deliberately generous to feasibility, because being wrong in
 * that direction costs a nicety and being wrong the other way costs bookings.
 */
export const GROUPING_CAP_SHARE = 0.3;

/** How long a whole scoring pass may take before it stops and leaves the rest neutral. */
export const GROUPING_DEADLINE_MS = 2_000;

/**
 * The most legs one scoring pass may measure.
 *
 * Three per candidate at worst, so this is roughly eight fully-scored slots. A cap on the PASS as
 * well as on the month, because a single conversation must not be able to spend a meaningful
 * fraction of a tenant's budget on preferences.
 */
export const GROUPING_LEG_BUDGET = 24;

/**
 * Claim elements for grouping, or answer false and let the caller go neutral.
 *
 * Never throws and never partially claims: a caller that cannot have what it asked for gets
 * nothing, because a half-funded scoring pass produces a partial cost, and a partial cost is not
 * a smaller truth - it is a different number.
 */
export async function reserveGroupingElements(tenantId: string, elements: number): Promise<boolean> {
  try {
    return await reserveTravelElements(tenantId, elements, GROUPING_CAP_SHARE);
  } catch (error) {
    // Failing closed is right here and is the opposite of the feasibility path's instinct.
    // Feasibility that cannot check must decide what to do about a customer; grouping that cannot
    // check simply has no opinion, and silence costs nothing.
    logger.warn('[grouping] could not reserve elements; scoring nothing', { tenantId, error });
    return false;
  }
}
