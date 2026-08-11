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
import { GROUPING_DEADLINE_MS, GROUPING_LEG_BUDGET, GROUPING_PAID_LEG_BUDGET } from './grouping-budget';
import { driveLookupFor } from './routes.service';
import { estimateDrive } from './travel-gate';
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
   * Elements this scoring actually billed - baseline legs, and nothing else.
   *
   * The two legs beside a candidate are read from the conversation's cache, where the feasibility
   * gate just put them, so they never appear here. Only `prev→next` is ever bought, once per gap,
   * and `GROUPING_PAID_LEG_BUDGET` is the hard stop.
   */
  elementsSpent: number;
  /**
   * Adjacent legs the cache could not answer, which grouping declined to buy.
   *
   * Not a cost - it is the size of the coverage gap. An adjacent leg missing means feasibility did
   * not route that pair for this candidate (it settled on the haversine bounds, or the slot came
   * back requestable), and buying it would be grouping paying to redo the gate's own work.
   */
  adjacentMisses: number;
  /**
   * How many legs in this scoring came from the haversine estimate rather than a real drive.
   *
   * LP4 needs to know how much of a cost rests on an estimate, because the two are not the same
   * evidence. Zero means every leg behind these numbers was measured.
   */
  estimatedLegs: number;
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
  let elementsSpent = 0;
  let adjacentMisses = 0;
  let estimatedLegs = 0;
  // EVERY leg the pass actually reaches a lookup for - hits, misses and purchases alike. A cache
  // hit is free in money and not free in time, and `GROUPING_LEG_BUDGET` is a bound on the
  // customer's wait. Counted out here because `scoreCandidates` counts within ONE call and the
  // pass makes one call per day, so a fortnight of days would each start with a full budget.
  let legsRead = 0;
  // Declared OUT here so a pass that runs out of time still hands back the candidates it finished.
  // A candidate is scored whole or not at all, so a short set is a smaller truth rather than a
  // different one - which is not the case for a partially-measured single candidate.
  const byStart = new Map<string, ScoredCandidate>();

  try {
    // TWO LOOKUPS, because the two kinds of leg have different rights.
    //
    // Adjacent legs are free or not had at all. They are the same pairs the feasibility gate just
    // routed for this candidate, so a hit is the norm and a miss means the gate did not route them
    // either - buying one would be grouping paying to redo the gate's own work.
    const cached = driveLookupFor(input.eligibility, input.sessionId, {
      cacheOnly: true,
      onWouldSpend: () => {
        adjacentMisses += 1;
      },
    });
    // The baseline is bought, because nothing else in the system ever asks for `prev→next` and it
    // is therefore never in the cache. Spending here is a real decision and not a convenience: an
    // earlier cut spent nothing and was measured blind to every candidate with a job on both
    // sides, which is the mid-day insertion grouping exists to find. It stays small because the
    // leg is per-GAP - same anchors, same departure instant, so the first candidate in a gap pays
    // and the rest read the answer.
    const paying = driveLookupFor(input.eligibility, input.sessionId, {
      // The deadline reaches the RESERVATION, not just the decision to look. The guard below runs
      // before the lookup starts, but a leg that starts at 1,999 ms of a 2,000 ms budget would
      // otherwise reserve an element and call Google well after the customer was answered.
      notAfter: deadline,
      onBilled: () => {
        elementsSpent += 1;
      },
    });

    // ONE PURCHASE PER GAP, made true here rather than hoped for downstream. The drive cache would
    // usually collapse these - same anchors, same departure instant, same key - but only usually:
    // it is skipped entirely when the session id is null, it is unavailable when Redis is down, a
    // failed answer is deliberately never cached, and `trafficAware` flips at the 24-hour horizon
    // and produces two keys for one instant. Under any of those, every candidate in a gap would
    // re-buy the identical leg until the budget ran out, and the per-gap magnitude this design is
    // justified by would quietly become per-candidate.
    const baselineMemo = new Map<string, number | null>();
    const memoKey = (from: { lat: number; lng: number }, to: { lat: number; lng: number }, departAt: Date) =>
      `${from.lat},${from.lng}:${to.lat},${to.lng}:${departAt.getTime()}`;

    const metered: LegLookup = async (from, to, departAt, purpose) => {
      const key = purpose === 'baseline' ? memoKey(from, to, departAt) : null;
      // A repeat of a leg already answered this pass, including a repeat of a FAILURE. Re-buying
      // something that just failed is the same waste as re-buying something that just succeeded.
      if (key !== null && baselineMemo.has(key)) return baselineMemo.get(key) ?? null;

      // BOTH BOUNDS ARE ENFORCED HERE, at the one point every leg passes through, and not only in
      // `scoreCandidates`' pre-check. That check debits its own counter AFTER the three lookups
      // return, so a leg that throws leaves it undebited and the next candidate is waved through;
      // and the deadline race resolves the caller without stopping `runPass`, which carries on
      // reading and buying behind it. Both make an advertised bound a hope rather than a fact.
      //
      // Refusing here returns null, which is a neutral candidate - the ordinary "no opinion"
      // outcome that refuses nothing.
      if (legsRead >= GROUPING_LEG_BUDGET || Date.now() > deadline) return null;
      legsRead += 1;

      // Cache-only once the paid budget is gone. The pass degrades rather than stopping: a
      // baseline already in the cache still scores, and only a MISS leaves the candidate neutral.
      const mayBuy = purpose === 'baseline' && elementsSpent < GROUPING_PAID_LEG_BUDGET;
      // `budgetMin` is the gate's own comparison, not the router's, and scoring is not budgeting a
      // gap: it wants the duration whatever it turns out to be. `Infinity` is that, said out loud.
      const answer = await (mayBuy ? paying : cached)({
        from,
        to,
        departAt,
        budgetMin: Number.POSITIVE_INFINITY,
      });
      if (key !== null) baselineMemo.set(key, answer.minutes);
      if (answer.minutes !== null) return answer.minutes;

      // ESTIMATE the legs beside a candidate rather than leave them unknown, and only those.
      //
      // The gap this closes is the opposite of the one the baseline purchase closed, and it bites
      // in exactly the wrong place. A leg the gate did not route is usually a leg it did not NEED
      // to route - `certainlyReachableWithin` cleared the slot from the bounds alone - and that
      // happens when the two points are CLOSE. So the unmeasured legs are the short ones, which
      // are the cheap insertions, which are the whole reason to prefer a slot. Measured live: a
      // customer beside an existing job scored `leg_unmeasured` while the expensive alternative
      // across the province scored fine.
      //
      // A preference may rest on an estimate where a refusal may not. Nothing here can turn a
      // confirmable Slot into a Request, so ADR-0015's "uncertainty splits three ways" is about a
      // different decision than this one.
      //
      // The SLOW end deliberately. It is the honest figure for a short urban hop, and where it is
      // wrong it overstates the cost - which understates the preference, and can only ever make
      // grouping quieter than the truth rather than louder.
      if (purpose !== 'adjacent') return null;
      estimatedLegs += 1;
      return estimateDrive(from, to).slowestMin;
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

        // Anchors for THIS day only, CONFIRMED only, and only those with a trusted position.
        //
        // Two independent exclusions and they are not the same rule. A neighbour whose address
        // never placed still blocks time through feasibility; it simply cannot be a node in a
        // route. A PENDING neighbour also still blocks time - but it must not anchor grouping,
        // because grouping is a claim that the owner is already working near there, and a booking
        // nobody has agreed to is not evidence that anybody is going anywhere.
        //
        // The confirmed-only rule was stated in `CONTEXT.md`, in ADR-0017 and in
        // `insertion-scorer.ts`'s own doc comment, and enforced in none of them: this function
        // received the feasibility list verbatim. It was correct only because no path writes a
        // `pending` row today, which is an accident rather than a guarantee.
        const anchors: RouteNode[] = input.neighbours
          // FAIL CLOSED on an absent status. `status` is optional on the type because the
          // synthetic premises neighbour has no row, and `!== 'pending'` would have let anything
          // unset anchor grouping as though it were confirmed - the exact accident this filter
          // exists to stop. Only an explicit `confirmed` may anchor.
          .filter((n) => n.status === 'confirmed')
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
          groupWholeDay: input.eligibility.groupingPeriod === 'full_day',
          lookup: metered,
          // Spent legs come off the budget, so a fortnight of days cannot each start with a full
          // one. The cap is on the PASS, and a pass is every day in the list.
          legBudget: Math.max(0, GROUPING_LEG_BUDGET - legsRead),
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
        elementsSpent,
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
      elementsSpent,
      adjacentMisses,
      estimatedLegs,
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
