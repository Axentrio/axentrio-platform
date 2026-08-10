/**
 * Actually offering the grouped order (#82, LP5).
 *
 * Every other file in this epic is measurement. This is the one that changes what a customer
 * sees, so it is deliberately small and deliberately separate: the decision to reorder should be
 * readable in one screen, and reviewable without reading the scorer.
 *
 * WHAT IT MAY DO: change the ORDER of an already-confirmable list, and attach a sentence saying
 * why the first one is first.
 *
 * WHAT IT MAY NOT DO: add a slot, remove a slot, change a slot's feasibility class, or promote a
 * requestable time above a confirmable one. ADR-0017. The list that comes out is a permutation of
 * the list that went in, and `assertPermutation` says so at runtime rather than in a comment.
 */
import { logger } from '../../utils/logger';
import type { OfferScoring } from './score-offer';

/** How the first slot came to be first, for the owner's audit trail. */
export type GroupingReasonCode = 'clustered_with_nearby_job' | 'no_preference';

export interface GroupedSlots<T extends { start: string }> {
  slots: T[];
  /**
   * The order these slots were in BEFORE grouping touched them, as ISO instants.
   *
   * Carried because the customer does not see this list - they see a prefix of it. Channels cap
   * quick replies (`capabilities.maxQuickReplies`, as low as 3), so a reorder that happens
   * entirely below the cap changes nothing anybody received. Recording that as delivered steering
   * puts an untreated offer in the pilot's treatment group, which is the one population the whole
   * comparison depends on being clean.
   *
   * Present only when the order actually changed.
   */
  previousOrder?: string[];
  /**
   * Present whenever the order actually changed - including changes too small to explain.
   *
   * #82's first decision is that BOTH parties are told, and the two are told differently. The
   * owner is told every time, because a silent reorder is still the platform making a decision on
   * their behalf. The customer is told only when the saving is worth a sentence, which is what
   * `customerReason` being absent means.
   */
  applied?: {
    reasonCode: GroupingReasonCode;
    /**
     * A sentence the model may pass on, written to be safe to show a customer.
     *
     * Absent when the saving is too small to be worth mentioning. NEVER says anything about
     * another customer - not their name, not their address, and not that they exist. A booking
     * flow is not a place to tell one customer about another's whereabouts.
     */
    customerReason?: string;
    /** Minutes of driving the preferred slot saves over the one that was going to be first. */
    savedMinutes: number;
  };
}

/**
 * A permutation, checked. Not decoration: a bug here shows up as a missing appointment slot
 * rather than as an exception, and the customer simply never sees a time they could have had.
 */
function isPermutation<T extends { start: string }>(before: T[], after: T[]): boolean {
  if (before.length !== after.length) return false;
  // Keyed on the WHOLE slot, not just its start. Two slots can share a start and differ in
  // duration, and treating those as interchangeable is how a sort quietly swaps a 30-minute
  // appointment for a 60-minute one while this function reports everything is fine.
  const identity = (s: T) => JSON.stringify(s);
  const seen = new Map<string, number>();
  for (const s of before) seen.set(identity(s), (seen.get(identity(s)) ?? 0) + 1);
  for (const s of after) {
    const n = seen.get(identity(s));
    if (!n) return false;
    seen.set(identity(s), n - 1);
  }
  return true;
}

/** The minimum saving worth saying a sentence about. Below it, reorder silently or not at all. */
const MIN_SAVING_TO_EXPLAIN = 10;

/**
 * Reorder a confirmable list into the order grouping prefers, or hand it back untouched.
 *
 * Returns the input unchanged - and no `applied` block - whenever grouping has nothing to say,
 * which is the common case and must stay cheap.
 */
export function applyGrouping<T extends { start: string }>(input: {
  slots: T[];
  scoring: OfferScoring | null;
  /** Off for everyone until an owner opts in. */
  enabled: boolean;
  /**
   * The customer asked about ONE local day.
   *
   * #82's own constraint. Ranking across days would tell somebody Thursday is better than the
   * Tuesday they asked for, and nothing in the request says they can move. `check_availability`
   * carries no provenance for the dates - the model chose them - so a wide range is not evidence
   * of flexibility, and treating it as such steers people who never agreed to be steered.
   * Structured flexibility is #84.
   */
  singleDay: boolean;
}): GroupedSlots<T> {
  const { slots, scoring } = input;
  if (!input.enabled || !input.singleDay || !scoring || slots.length < 2) return { slots };

  const rank = new Map(scoring.counterfactualOrder.map((start, i) => [start, i]));
  const keyOf = (s: T) => {
    const t = Date.parse(s.start);
    return Number.isNaN(t) ? s.start : new Date(t).toISOString();
  };
  // A slot the scorer never ranked keeps its place at the back rather than jumping to the front on
  // a missing key. `Infinity` and a stable sort together mean "unranked things stay in the order
  // they arrived", which is chronological.
  const reordered = [...slots].sort((a, b) => (rank.get(keyOf(a)) ?? Infinity) - (rank.get(keyOf(b)) ?? Infinity));

  if (!isPermutation(slots, reordered)) {
    // Refuse rather than repair. A list that is not a permutation means the sort lost or
    // duplicated a time, and offering a repaired one hides a real bug behind a plausible answer.
    logger.warn('[grouping] reordering did not produce a permutation; offering the original order', {
      before: slots.length,
      after: reordered.length,
    });
    return { slots };
  }

  // ANY positional change, not just a change of first. A tail-only reorder still moved times
  // around on the customer's screen, and "every reorder is auditable" has to mean every one.
  const moved = reordered.some((s, i) => keyOf(s) !== keyOf(slots[i]));
  if (!moved) return { slots: reordered };


  const first = keyOf(reordered[0]);
  const wasFirst = keyOf(slots[0]);

  // Measured against the slot that WOULD have been offered first, which is the only comparison a
  // customer could notice. A tail-only reorder leaves these equal and therefore saves nothing.
  const preferredCost = scoring.scores[first]?.costMinutes;
  const displacedCost = scoring.scores[wasFirst]?.costMinutes;
  const savedMinutes =
    preferredCost !== null && preferredCost !== undefined && displacedCost !== null && displacedCost !== undefined
      ? displacedCost - preferredCost
      : 0;

  return {
    slots: reordered,
    previousOrder: slots.map(keyOf),
    applied: {
      reasonCode: savedMinutes >= MIN_SAVING_TO_EXPLAIN ? 'clustered_with_nearby_job' : 'no_preference',
      savedMinutes,
      // Reordered but not worth a sentence. The owner is still told, above; the customer is not,
      // because being told their preferred time is worse by four minutes gives them a reason to
      // distrust the next thing the bot says and buys nothing.
      //
      // Says nothing about another customer, INCLUDING that one exists. An earlier draft said the
      // time "fits with the other work already booked in your area", which reveals a booking and
      // roughly where it is - a leak with no name attached is still a leak.
      ...(savedMinutes >= MIN_SAVING_TO_EXPLAIN
        ? {
            customerReason:
              'This time fits our schedule for that day best, so it is the one we can most reliably keep.',
          }
        : {}),
    },
  };
}
