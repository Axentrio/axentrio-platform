/**
 * What one extra job COSTS the owner's half-day (#81, LP4).
 *
 * Feasibility already answered whether a Slot is reachable. This answers a different question: of
 * the Slots that are reachable, which one adds the fewest driving minutes to the day the owner
 * already has? A plumber with jobs in Aalst at 09:00 and 11:00 should be offered 10:00 in Aalst
 * before 10:00 in Gent, and today both look identical.
 *
 * SHADOW ONLY. Nothing here reorders what a customer sees. The scores are recorded so LP4's gate
 * can be measured - score distributions, element cost, latency, and how often a cheaper
 * alternative even exists - and LP5 is the separate decision to act on them. That separation is
 * the point: steering customers on an unmeasured scorer is what the phasing exists to prevent.
 *
 * ADR-0017 governs: grouping PREFERS a Slot, it never refuses one. Nothing in this file may
 * remove a Slot, downgrade its feasibility class, or turn it into a Request. The worst thing it
 * may do is decline to express a preference.
 *
 * Contract: `docs/specs/location-aware-planning.md`, "The scoring contract".
 */
import { logger } from '../../utils/logger';
import type { HalfDayPeriod, DayPeriods } from './half-day';
import { periodOf } from './half-day';

/** A point the owner must actually drive to. */
export interface RouteNode {
  /** Buffer-expanded, because the drive leaves when the previous job's block ends. */
  blockedStart: Date;
  blockedEnd: Date;
  point: { lat: number; lng: number };
}

/** Why a candidate carries no preference. Recorded, because "neutral" alone diagnoses nothing. */
export type NeutralReason =
  /** No anchors and no Base in this period - there is nothing to be near. */
  | 'unanchored'
  /** Buffer-expanded range crosses the boundary, so it belongs to neither period. */
  | 'straddles_boundary'
  /** A coarse or unresolved position. A dot standing for a town cannot say a drive is efficient. */
  | 'position_not_trusted'
  /** A required leg could not be measured - lookup failed, or the scoring budget ran out. */
  | 'leg_unmeasured'
  /** The day has no periods at all: closed, or always-open. */
  | 'no_periods';

export interface ScoredCandidate {
  start: Date;
  /** Marginal minutes this candidate adds, or null when it carries no preference. */
  costMinutes: number | null;
  /** Null when `costMinutes` is null. `false` means scored but over the owner's threshold. */
  preferred: boolean | null;
  neutralReason: NeutralReason | null;
  period: HalfDayPeriod | null;
}

/**
 * WHICH leg is being asked for, because the two kinds cost differently.
 *
 * `adjacent` is `prev→candidate` or `candidate→next` - exactly the pairs the feasibility gate
 * routes for this same candidate, so they are already in the conversation's drive cache and cost
 * nothing to read.
 *
 * `baseline` is `prev→next`, the leg that says what the day cost WITHOUT this candidate. Nothing
 * else in the system ever needs it, so it is never cached and somebody has to buy it. It is also
 * per-GAP rather than per-candidate: the same two anchors and the same departure instant, so
 * every candidate in that gap reads one purchase.
 */
export type LegPurpose = 'adjacent' | 'baseline';

/** Measures one leg, or answers null when it cannot. Never throws, never estimates. */
export type LegLookup = (
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  departAt: Date,
  purpose: LegPurpose
) => Promise<number | null>;

export interface ScoreInput {
  candidates: Array<{ blockedStart: Date; blockedEnd: Date; point: { lat: number; lng: number } | null }>;
  /** `confirmed` bookings with a trusted position, in this day, chronological. */
  anchors: RouteNode[];
  periods: DayPeriods | null;
  /** The premises, when start-from-base is on. Only ever a `prev`, and only for the day's first. */
  base: { point: { lat: number; lng: number }; departAt: Date } | null;
  /** Minutes one candidate may add. Null means no threshold. */
  maxDetourMin: number | null;
  lookup: LegLookup;
  /** Stop scoring once this many legs have been measured. Overflow is neutral, never a Request. */
  legBudget: number;
  /** Stop scoring once this instant passes, for the same reason. */
  deadline: number;
}

/**
 * Score every candidate. Never throws.
 *
 * Returns one entry per candidate in the order given. A caller may reorder its own output from
 * these; this function does not reorder anything.
 */
export async function scoreCandidates(input: ScoreInput): Promise<ScoredCandidate[]> {
  const { periods } = input;
  const neutral = (
    start: Date,
    neutralReason: NeutralReason,
    period: HalfDayPeriod | null = null
  ): ScoredCandidate => ({ start, costMinutes: null, preferred: null, neutralReason, period });

  if (!periods) return input.candidates.map((c) => neutral(c.blockedStart, 'no_periods'));

  // Anchors bucketed once. Chronological within a period is what makes `prev`/`next` meaningful,
  // and the input order is not guaranteed to be.
  const byPeriod: Record<HalfDayPeriod, RouteNode[]> = { morning: [], afternoon: [] };
  for (const a of input.anchors) {
    const p = periodOf({ start: a.blockedStart, end: a.blockedEnd }, periods);
    // An anchor that straddles the boundary anchors NEITHER period. It is a real job and it still
    // blocks time through feasibility; it simply cannot be said to belong to a half-day.
    if (p) byPeriod[p].push(a);
  }
  for (const p of ['morning', 'afternoon'] as const) {
    byPeriod[p].sort((a, b) => a.blockedStart.getTime() - b.blockedStart.getTime());
  }

  /**
   * The day's first constraining job, which is the only candidate the Base may precede.
   *
   * Start-from-base says the owner leaves home for their FIRST job. It says nothing about the
   * second, and nothing at all about going home - so the Base is never a `next`, and never a
   * `prev` for anything but the earliest booking of the whole local day.
   */
  const earliestAnchor = [...byPeriod.morning, ...byPeriod.afternoon].reduce<RouteNode | null>(
    (min, a) => (!min || a.blockedStart < min.blockedStart ? a : min),
    null
  );

  let legsUsed = 0;
  const out: ScoredCandidate[] = [];

  for (const candidate of input.candidates) {
    if (!candidate.point) {
      // ADR-0014's rule reaches preference too: a coarse or unresolved position may refuse a
      // drive and may never clear one, so it certainly cannot call one efficient.
      out.push(neutral(candidate.blockedStart, 'position_not_trusted'));
      continue;
    }

    const period = periodOf({ start: candidate.blockedStart, end: candidate.blockedEnd }, periods);
    if (!period) {
      out.push(neutral(candidate.blockedStart, 'straddles_boundary'));
      continue;
    }

    const anchors = byPeriod[period];
    const prevAnchor = [...anchors].reverse().find((a) => a.blockedEnd <= candidate.blockedStart) ?? null;
    const nextAnchor = anchors.find((a) => a.blockedStart >= candidate.blockedEnd) ?? null;

    // The Base stands in as `prev` only at the very front of the day, and only when nothing else
    // precedes this candidate.
    const isDayFirst = !earliestAnchor || candidate.blockedStart < earliestAnchor.blockedStart;
    const prev = prevAnchor
      ? { point: prevAnchor.point, departAt: prevAnchor.blockedEnd }
      : input.base && isDayFirst
        ? input.base
        : null;

    // An unanchored period has nothing to be near. Every Slot in it is neutral - NOT "all equally
    // preferred", which would rank them above a period that genuinely clusters.
    if (!prev && !nextAnchor) {
      out.push(neutral(candidate.blockedStart, 'unanchored', period));
      continue;
    }

    // Budget checked BEFORE spending, and the whole candidate goes neutral rather than half-scored.
    // A partial cost is not a smaller truth, it is a different number.
    const legsNeeded = (prev ? 1 : 0) + (nextAnchor ? 1 : 0) + (prev && nextAnchor ? 1 : 0);
    if (legsUsed + legsNeeded > input.legBudget || Date.now() > input.deadline) {
      out.push(neutral(candidate.blockedStart, 'leg_unmeasured', period));
      continue;
    }

    try {
      // DEPARTURE TIMES ARE FIXED, not chosen. Traffic-aware answers are departure-bucketed, so a
      // scorer free to pick its own departure would score one itinerary differently run to run -
      // and LP4's whole gate is whether the ranking is stable.
      const toCandidate = prev ? await input.lookup(prev.point, candidate.point, prev.departAt, 'adjacent') : 0;
      const fromCandidate = nextAnchor
        ? await input.lookup(candidate.point, nextAnchor.point, candidate.blockedEnd, 'adjacent')
        : 0;
      // The counterfactual: what the two anchors cost each other with nobody between them. Not a
      // leg feasibility ever measures, so it is the one the caller may have to pay for.
      const baseline =
        prev && nextAnchor ? await input.lookup(prev.point, nextAnchor.point, prev.departAt, 'baseline') : 0;
      legsUsed += legsNeeded;

      if (toCandidate === null || fromCandidate === null || baseline === null) {
        out.push(neutral(candidate.blockedStart, 'leg_unmeasured', period));
        continue;
      }

      const costMinutes = toCandidate + fromCandidate - baseline;
      // The threshold bounds the marginal minutes ONE candidate adds. Over it means NOT PREFERRED
      // and nothing else: the Slot keeps its feasibility class, stays confirmable, is still
      // offered. `<=` so a candidate exactly at the threshold is preferred.
      const preferred = input.maxDetourMin === null ? true : costMinutes <= input.maxDetourMin;
      out.push({ start: candidate.blockedStart, costMinutes, preferred, neutralReason: null, period });
    } catch (error) {
      // A scorer that can break a booking is worse than one that says nothing.
      logger.warn('[grouping] scoring a candidate failed; leaving it neutral', { error });
      out.push(neutral(candidate.blockedStart, 'leg_unmeasured', period));
    }
  }

  return out;
}
