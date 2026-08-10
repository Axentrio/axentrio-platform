/**
 * Running the grouping scorer over a real slot list (#81).
 *
 * The seam between the travel gate's world and the scorer's. The gate already holds everything
 * needed - the day's neighbours and the customer's placed point - and this turns that into per-day
 * scoring without the gate having to know how grouping works.
 *
 * SHADOW. Nothing here reorders anything or changes a single slot's feasibility class. It produces
 * numbers, and `slot-ordering.ts` produces the order those numbers WOULD have given, for LP4's
 * gate to be measured against later.
 *
 * PER LOCAL DAY, which is the part that is easy to miss. A slot list routinely spans a fortnight,
 * and a half-day period belongs to one date: scoring a Tuesday candidate against Monday's jobs
 * would cluster a day the customer is not being offered.
 */
import { DateTime } from 'luxon';
import { logger } from '../../utils/logger';
import { localDayBounds, type DayRule } from './travel-day';
import { windowsForDay } from '../booking-providers/slot-engine';
import { resolveDayPeriods } from './half-day';
import { scoreCandidates, type LegLookup, type RouteNode, type ScoredCandidate } from './insertion-scorer';
import { counterfactualOrder, hasCheaperAlternative, SCORER_VERSION } from './slot-ordering';
import { GROUPING_DEADLINE_MS, GROUPING_LEG_BUDGET } from './grouping-budget';
import { driveLookupFor } from './routes.service';
import type { NeighbourLocation, TravelNeighbour } from './travel-gate';
import type { ActiveTravelEligibility } from './travel-eligibility';
import type { GeoPoint } from '../../contracts/travel';

/** The minimum saving worth calling an alternative "cheaper" (#85's pre-registered gate). */
const MIN_SAVING_MINUTES = 10;

/**
 * What the scorer thought, in a shape that survives the trip to the dispatch boundary.
 *
 * PLAIN DATA, deliberately - no Map, no Date. This rides on the response payload from the agent to
 * whichever channel sends it, and a serialising hop would silently flatten a Map to `{}`, leaving a
 * row that claims a scorer ran and records nothing it decided.
 *
 * Keyed by ISO instant rather than by position, because the channel truncates the slot list and an
 * index-paired cost is one truncation away from being attributed to the wrong time.
 */
export interface OfferScoring {
  scorerVersion: string;
  scores: Record<string, SlotScore>;
  /**
   * The order over the WHOLE scored list, not the channel-sized prefix of it.
   *
   * Deliberate, and the reason is what the counterfactual is for: LP5 reorders before the channel
   * truncates, so "what steering would have delivered" is the top N of THIS order - which is only
   * recoverable if the order below N is recorded too. Truncating here would throw away the slots
   * that steering would have promoted INTO the offer, which are the whole point.
   */
  counterfactualOrder: string[];
  cheaperAlternativeExisted: boolean;
  /**
   * What this scoring WOULD have cost in elements, having cost nothing.
   *
   * Grouping never buys a leg, so the honest number is not what it spent - it spent zero - but
   * how many legs it had to decline. That answers LP4's cost question without the spending that
   * would make the answer worth having.
   *
   * WHAT IT IS AND IS NOT, because LP5's go/no-go turns on it:
   *
   *   - Not censored by early exit. `scoreCandidates` awaits all three of a candidate's legs
   *     before it looks at any of them, so a missed first leg does not hide the other two.
   *   - Bounded by `GROUPING_LEG_BUDGET` and the deadline, so a very long list stops being
   *     counted at the same point a paid pass would stop being spent. Same bound either way.
   *   - Slightly HIGH, not low, and only slightly: a paid pass would warm the cache with its own
   *     answers, so a later leg between the same pair would hit for free where this one counts a
   *     miss. Erring upward is the safe direction for a spending decision.
   */
  elementsWouldSpend: number;
  ms: number;
}

export interface SlotScore {
  costMinutes: number | null;
  preferred: boolean | null;
  neutralReason: string | null;
  period: 'morning' | 'afternoon' | null;
}

/** Only a trusted position is a route node. Coarse may refuse a drive; it may never rank one. */
function trustedPoint(location: NeighbourLocation): GeoPoint | null {
  return location.kind === 'known' ? location.point : null;
}

/**
 * Score a confirmable slot list, or answer null when grouping has nothing to say.
 *
 * NEVER THROWS, and the whole body is inside the guard for that reason rather than as a habit.
 * ADR-0017 says grouping may prefer a slot and may never refuse one, so an exception escaping here
 * would take out an entire availability answer on behalf of a preference - which is a worse
 * outcome than the scorer never having existed.
 */
export async function scoreOfferedSlots(input: {
  eligibility: ActiveTravelEligibility;
  /** Scopes the drive cache. The same conversation's feasibility legs are reused for free. */
  sessionId: string | null;
  rule: DayRule;
  /** Confirmable slots only. A slot travel could not clear is not one to steer anyone toward. */
  slots: Array<{ start: string; end: string }>;
  requestable: Array<{ start: string; end: string }>;
  /** The customer's placed point, or null when it is coarse or unresolved. */
  candidatePoint: GeoPoint | null;
  neighbours: TravelNeighbour[];
  /** Base and its departure instant, per day, from the gate's own resolution. */
  baseFor: (candidateStart: Date) => { base: { at: Date; location: NeighbourLocation } | null };
  boundaryOverride?: string | null;
}): Promise<OfferScoring | null> {
  if (!input.slots.length) return null;

  const startedAt = Date.now();
  const deadline = startedAt + GROUPING_DEADLINE_MS;
  const tenantId = input.eligibility.tenantId;
  let elementsWouldSpend = 0;
  // Declared OUT here so a pass that runs out of time still hands back the candidates it finished.
  // A candidate is scored whole or not at all, so a short set is a smaller truth rather than a
  // different one - which is not the case for a partially-measured single candidate.
  const byStart = new Map<string, ScoredCandidate>();

  try {
    // CACHE-ONLY, which is what makes this a shadow feature rather than a cheap one. Grouping and
    // the feasibility gate share one monthly element counter, so a scorer that spends ANY of it
    // can bring a tenant to an exhaustion they would not otherwise have reached - and an
    // exhausted gate turns confirmable slots into Requests, which is precisely what ADR-0017
    // forbids grouping from causing. A capped share bounds that harm; it does not remove it.
    //
    // The legs this conversation's feasibility pass already measured are here for nothing, and
    // those are the same prev/next legs the scorer wants. What it cannot answer for free it
    // declines and counts, which is LP4's cost question answered without paying it.
    const drive = driveLookupFor(input.eligibility, input.sessionId, {
      cacheOnly: true,
      onWouldSpend: () => {
        elementsWouldSpend += 1;
      },
    });
    const metered: LegLookup = async (from, to, departAt) => {
      // `budgetMin` is the gate's own comparison, not the router's, and scoring is not budgeting a
      // gap: it wants the duration whatever it turns out to be. `Infinity` is that, said out loud.
      const answer = await drive({ from, to, departAt, budgetMin: Number.POSITIVE_INFINITY });
      return answer.minutes;
    };

    // Grouped by LOCAL day: a period is a property of one date, and the slot list spans many.
    // Keyed by the local date STRING, with the Luxon day kept beside it: the key is what groups,
    // and `windowsForDay` wants the DateTime.
    const byDay = new Map<string, { day: DateTime; slots: Array<{ start: string; end: string }> }>();
    for (const slot of input.slots) {
      const { localDay } = localDayBounds(input.rule, new Date(slot.start));
      const key = localDay.toFormat('yyyy-MM-dd');
      const entry = byDay.get(key) ?? { day: localDay, slots: [] };
      entry.slots.push(slot);
      byDay.set(key, entry);
    }

    const runPass = async () => {
      for (const [localDay, { day, slots: daySlots }] of byDay) {
        const periods = resolveDayPeriods({
          localDay,
          timezone: input.rule.timezone,
          // The EFFECTIVE windows, date overrides already applied - a holiday closure changes where
          // the boundary sits, and reading the weekly grid would put it on a day that is shut.
          windows: windowsForDay(input.rule as Parameters<typeof windowsForDay>[0], day),
          alwaysOpen: input.rule.availabilityMode === 'always_open',
          boundaryOverride: input.boundaryOverride ?? null,
        });

        // Anchors for THIS day only, and only those with a trusted position. A neighbour whose
        // address never placed still blocks time through feasibility; it simply cannot be a node.
        const anchors: RouteNode[] = input.neighbours
          .filter((n) => localDayBounds(input.rule, n.blockedStart).localDay.toFormat('yyyy-MM-dd') === localDay)
          .map((n) => ({ blockedStart: n.blockedStart, blockedEnd: n.blockedEnd, point: trustedPoint(n.location) }))
          .filter((n): n is RouteNode => n.point !== null);

        const { base } = input.baseFor(new Date(daySlots[0].start));
        const basePoint = base ? trustedPoint(base.location) : null;

        const scored = await scoreCandidates({
          candidates: daySlots.map((s) => ({
            blockedStart: new Date(s.start),
            blockedEnd: new Date(s.end),
            point: input.candidatePoint,
          })),
          anchors,
          periods,
          base: base && basePoint ? { point: basePoint, departAt: base.at } : null,
          maxDetourMin: input.eligibility.maxDetourMin,
          lookup: metered,
          // Spent legs come off the budget, so a fortnight of days cannot each start with a full
          // one. The cap is on the PASS, and a pass is every day in the list.
          legBudget: GROUPING_LEG_BUDGET - elementsWouldSpend,
          deadline,
        });

        daySlots.forEach((slot, i) => {
          if (scored[i]) byStart.set(new Date(slot.start).toISOString(), scored[i]);
        });
      }
    };

    // A HARD wall-clock bound, because `deadline` is only consulted between candidates and an
    // in-flight leg has its own 5-second timeout that nothing here can interrupt.
    // Held on an object because both of these are written from inside a callback, and a plain
    // `let` would be narrowed back to its initial value by the reads below.
    const pass: { timedOut: boolean; failure: string | null } = { timedOut: false, failure: null };
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      // The abandoned pass is left to finish on its own: its reservations are already spent and
      // its answers still land in the drive cache, so nothing is wasted except the wait. It needs
      // its own handler for two different failures, and conflating them reopens the very hole the
      // deadline rule closes. AFTER the deadline nobody is reading the result, so a failure there
      // is only worth a log. BEFORE it, the race resolves normally with `timedOut` still false -
      // and without recording the failure the code below would sail on and publish whatever
      // partial `byStart` held as a complete scoring.
      runPass().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (pass.timedOut) {
          logger.warn('[grouping] the abandoned scoring pass failed after the deadline', {
            tenantId,
            error: message,
          });
          return;
        }
        pass.failure = message;
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          pass.timedOut = true;
          resolve();
        }, GROUPING_DEADLINE_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (pass.failure) {
      logger.warn('[grouping] scoring failed part-way; the slot list is unaffected', {
        tenantId,
        error: pass.failure,
      });
      return null;
    }

    // NOTHING, on a timeout. Everything below is a statement about the WHOLE offered list -
    // `counterfactualOrder` is the order over all of it, and `cheaperAlternativeExisted` is a
    // claim that nowhere better existed. Computed from a partial pass, the second one answers
    // `false` because the cheaper slot had not been reached yet, and that is not a smaller truth:
    // it is the exact metric LP4 exists to produce, silently wrong, in a row indistinguishable
    // from a complete one.
    //
    // Partial is not salvageable at a finer grain either. A day's candidates land in `byStart`
    // only when that day's whole `scoreCandidates` call returns, so a pass stuck on the last
    // candidate of a day loses the earlier ones anyway.
    //
    // The absence is already a first-class state - a null `scorer_version` on the row - and the
    // diagnostic that would have been worth keeping goes to the log, where it cannot be counted.
    if (pass.timedOut) {
      logger.warn('[grouping] scoring hit its deadline; recording no scoring for this offer', {
        tenantId,
        slots: input.slots.length,
        elementsWouldSpend,
        ms: Date.now() - startedAt,
      });
      return null;
    }

    const allScored = [...byStart.values()];
    const scores: Record<string, SlotScore> = {};
    for (const [start, c] of byStart) {
      scores[start] = {
        costMinutes: c.costMinutes,
        preferred: c.preferred,
        neutralReason: c.neutralReason,
        period: c.period,
      };
    }

    return {
      scorerVersion: SCORER_VERSION,
      scores,
      counterfactualOrder: counterfactualOrder({
        scored: allScored,
        requestable: input.requestable.map((s) => new Date(s.start)),
      }),
      cheaperAlternativeExisted: hasCheaperAlternative(
        allScored,
        new Date(input.slots[0].start),
        MIN_SAVING_MINUTES
      ),
      elementsWouldSpend,
      ms: Date.now() - startedAt,
    };
  } catch (error) {
    // The MESSAGE, not the object. A bare `Error` serialises to `{}` through the JSON transport,
    // and the one line that says why grouping went quiet would then say nothing at all.
    logger.warn('[grouping] scoring failed; the slot list is unaffected', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
