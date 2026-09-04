/**
 * The order grouping WOULD offer (#81), recorded and not applied.
 *
 * LP4 changes nothing a customer sees, so this is the only record of what steering would have
 * done - and LP5's whole comparison is against it. Kept as its own module for two reasons: LP5
 * becomes a call rather than a rewrite, and the ordering can be tested for determinism without a
 * database, a diary or a customer anywhere near it.
 *
 * DETERMINISM IS THE PROPERTY, not a nicety. LP4's gate is whether the ranking is stable, and a
 * comparator with an undefined case makes that unfalsifiable: the same diary would rank
 * differently between runs and nobody could say whether the scorer or the sort had moved.
 *
 * Contract: `docs/specs/location-aware-planning.md`, "Ordering, and it must be deterministic".
 */
import type { ScoredCandidate } from './insertion-scorer';

/** Bump when the ORDER this produces could change for an unchanged diary. */
export const SCORER_VERSION = 'lp4-1';

/**
 * Confirmable slots in the order grouping would prefer, then requestable ones.
 *
 * Three groups, in this order, and requestable never rises above confirmable:
 *
 *   1. Every candidate with `costMinutes !== null`, cheapest first. Ties chronological.
 *   2. Neutral (`costMinutes === null`), chronological.
 *   3. Requestable, chronological. A slot travel could not clear is not a slot to steer
 *      anyone toward, and promoting one would offer a customer a time the owner may refuse.
 *
 * Ties inside any group break chronologically, so two equal costs cannot swap between runs.
 */
export function counterfactualOrder(input: {
  scored: ScoredCandidate[];
  /** Instants that came back as requestable rather than confirmable. */
  requestable: Date[];
}): string[] {
  const chronologically = (a: { start: Date }, b: { start: Date }) => a.start.getTime() - b.start.getTime();

  const scored = input.scored
    .filter((s) => s.costMinutes !== null)
    .sort((a, b) => {
      const byCost = (a.costMinutes as number) - (b.costMinutes as number);
      // The tie-break is load-bearing: `Array.prototype.sort` is only stable within one engine's
      // implementation of one comparator, and "equal costs keep input order" would inherit
      // whatever order the slot generator happened to emit.
      return byCost !== 0 ? byCost : chronologically(a, b);
    });

  const neutral = input.scored.filter((s) => s.costMinutes === null).sort(chronologically);

  return [
    ...scored.map((s) => s.start.toISOString()),
    ...neutral.map((s) => s.start.toISOString()),
    ...[...input.requestable].sort((a, b) => a.getTime() - b.getTime()).map((d) => d.toISOString()),
  ];
}

/**
 * Did a cheaper alternative exist than the slot offered first?
 *
 * LP4's most decision-shaped gate: if steering rarely has anywhere better to point, the pilot
 * cannot move any number whatever it does, and the epic stops having cost one ticket rather than
 * a live feature. Answered per offer so the share can be read over a window.
 *
 * `minSavingMinutes` is the floor below which a saving is not worth nudging a customer over.
 */
export function hasCheaperAlternative(
  scored: ScoredCandidate[],
  firstOffered: Date,
  minSavingMinutes: number
): boolean {
  const offered = scored.find((s) => s.start.getTime() === firstOffered.getTime());
  // No score for what was actually shown means no comparison is possible - which is not the same
  // as no alternative, and must not be counted as one.
  if (!offered || offered.costMinutes === null) return false;
  return scored.some(
    (s) => s.costMinutes !== null && (offered.costMinutes as number) - s.costMinutes >= minSavingMinutes
  );
}
