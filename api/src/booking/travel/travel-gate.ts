/**
 * Can the owner get there? The verdict, and nothing else.
 *
 * WHAT THIS DECIDES. Given a candidate appointment at a known place, and the jobs immediately
 * before and after it in the same diary, this answers one of three things: the drive is
 * certainly fine, the drive is certainly impossible, or nobody here can tell. It is the whole
 * of the feasibility rule and it is pure — no Google, no database, no clock. `travel.ts` holds
 * the arithmetic, `travel-neighbours.ts` holds the loading; this holds the reasoning that
 * joins them, so it can be tested by writing down two coordinates and a gap.
 *
 * THREE VERDICTS, NOT TWO, and the third is the point of the design. Without a routing API the
 * honest answer to most pairs is "I do not know", and the two haversine bounds are what turn
 * the extremes of that into certainty: below the pessimistic bound the worst plausible crawl
 * still arrives, above the optimistic bound not even a straight line at motorway speed fits.
 * Everything between is opinion, and opinion becomes a Request for the owner rather than a
 * silent confirmation or a lost customer.
 *
 * WHAT IT NEVER DOES. It never asks whether a job is a GOOD use of the day. Feasibility blocks;
 * efficiency must not. If the owner can reach city B in the gap available, city B is bookable,
 * and refusing it turns away someone who wants to pay.
 */
import {
  certainlyReachableWithin,
  couldReachWithin,
  haversineKm,
  PREFILTER_MAX_KMH,
  DISPLAY_SLOWEST_KMH,
  type GeoPoint,
} from '../../contracts/travel';

/**
 * `unreachable` is a proof; `clear` is either a proof or a measurement depending on how it
 * was reached; `undecided` is the absence of both.
 *
 * The asymmetry is not sloppiness. `unreachable` from `couldReachWithin` really is
 * conclusive — nothing beats a straight line at motorway speed. `clear` is conclusive when
 * routing measured it, and a calibrated bet when only `certainlyReachableWithin` did, which
 * is exactly the distinction `travel_check` records as `ok` versus `degraded`.
 *
 * Named for what is known rather than for what to do about it, because the two callers do
 * different things with the same verdict: availability withholds an `undecided` slot from the
 * confirmable list, create turns it into a Request.
 */
export type TravelVerdict = 'clear' | 'unreachable' | 'undecided';

/** One drive routing could settle: both ends properly placed, the bounds inconclusive. */
export interface RoutableLeg {
  from: GeoPoint;
  to: GeoPoint;
  /** Minutes left for the drive once the owner's slack is out of the gap. */
  budgetMin: number;
  /** When the van leaves — the end of the earlier job's blocked range. */
  departAt: Date;
}

/**
 * One side's answer, and enough context to decide what to do next.
 *
 * `constraining` separates "no drive to fit" from "a drive we settled". Only the second kind
 * can leave a slot short of `ok`, which is why an empty day still confirms as verified rather
 * than being demoted for a question nobody asked.
 */
type SideOutcome = {
  verdict: TravelVerdict;
  constraining: boolean;
  /** Present only when routing could settle this leg. */
  leg?: RoutableLeg;
};

/**
 * How well we know where a neighbouring job is — four states, and collapsing any two of them
 * is how this feature silently confirms a drive nobody checked.
 *
 * `locationless` and `unresolved` look identical from a database row and mean opposite things.
 * A phone consultation HAS no location: the owner could take it from the van, so it constrains
 * nothing and the flat gap is the whole rule (plan §6.6). A job that should have a location and
 * does not — an address Google would not place, a tenant that spent its cap, coordinates aged
 * past the thirty days the licence permits — has one we could not obtain, and treating that as
 * "no constraint" is exactly the fail-open ADR-0015 exists to refuse.
 *
 * `coarse` is the town-centre case. It collapses every address in a municipality onto one dot,
 * so it can prove a drive impossible and can never prove one fine (ADR-0014).
 */
export type NeighbourLocation =
  | { kind: 'known'; point: GeoPoint }
  | { kind: 'coarse'; point: GeoPoint }
  | { kind: 'locationless' }
  | { kind: 'unresolved' };

/** A held job either side of the candidate, as far as travel is concerned. */
export interface TravelNeighbour {
  /**
   * BUFFER-EXPANDED bounds, not the raw appointment. The gap is measured between blocked
   * ranges because a service's own before/after buffers already sit inside them, which is
   * what makes the flat gap and the buffers compose by addition while the drive and the flat
   * gap compose by `max`.
   */
  blockedStart: Date;
  blockedEnd: Date;
  location: NeighbourLocation;
}

/** The slot being judged. `coarse` when the CUSTOMER's own address placed only to a town. */
export interface TravelCandidate {
  blockedStart: Date;
  blockedEnd: Date;
  point: GeoPoint;
  coarse: boolean;
}

export interface AssessTravelInput {
  candidate: TravelCandidate;
  /** The immediately preceding held job, or null when nothing precedes it. */
  before: TravelNeighbour | null;
  /** The immediately following held job, or null. */
  after: TravelNeighbour | null;
  /** The owner's margin on top of the drive: parking, the doorstep, overrunning. */
  slackMin: number;
}

/** Whole minutes between two instants, floored — a partial minute is not a minute of driving. */
function minutesBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 60_000);
}

/**
 * One side of the candidate, judged.
 *
 * THE FLAT GAP IS NOT READ HERE, and that is not an omission. Clearance between two jobs is
 * `max(minGapMin, drive + slack)`, and the `max` is realised by the two halves running
 * independently: everything closer than `minGapMin` was already removed before this function
 * saw it — by the busy-interval inflation on the offer path and by `enforceBusinessCapacity`
 * on the write path — so a candidate arriving here already satisfies the floor, and all this
 * adds is `drive + slack <= gap`. Applying the floor again here would compare a number against
 * a bound it has already cleared.
 */
function assessSide(
  candidate: TravelCandidate,
  neighbour: TravelNeighbour | null,
  slackMin: number,
  /** 'before' measures neighbour.blockedEnd → candidate.blockedStart; 'after' is the mirror. */
  side: 'before' | 'after'
): SideOutcome {
  // Nothing parked on this side, so there is no drive to fit. The day being empty is the one
  // case where travel time genuinely has nothing to say — and it does NOT count as a leg that
  // routing left unanswered, because there was no question.
  if (!neighbour) return { verdict: 'clear', constraining: false };
  if (neighbour.location.kind === 'locationless') return { verdict: 'clear', constraining: false };
  if (neighbour.location.kind === 'unresolved') return { verdict: 'undecided', constraining: true };

  const gapMin =
    side === 'before'
      ? minutesBetween(neighbour.blockedEnd, candidate.blockedStart)
      : minutesBetween(candidate.blockedEnd, neighbour.blockedStart);

  // What is left for the drive itself once the owner's own margin is taken out. Negative is
  // normal rather than an error: it means the margin alone does not fit, and `couldReachWithin`
  // answers that correctly — only two jobs at literally the same coordinates survive it.
  const budgetMin = gapMin - Math.max(0, slackMin);

  // DIRECTION DOES NOT MATTER to either bound. Both are symmetric functions of a great-circle
  // distance, so `from`/`to` are written in travel order purely for the reader.
  const from = side === 'before' ? neighbour.location.point : candidate.point;
  const to = side === 'before' ? candidate.point : neighbour.location.point;

  // Certain, and certain in the direction that costs a customer a slot — so it is the one
  // place a coarse point is still allowed to speak. ADR-0014: coarse positions can raise an
  // alarm, they just cannot clear one.
  if (!couldReachWithin(from, to, budgetMin)) return { verdict: 'unreachable', constraining: true };

  // Certain the other way, and this requires BOTH ends to be properly placed. A town centre on
  // either end would be clearing a drive between two dots rather than between two doors.
  const bothPlaced = !candidate.coarse && neighbour.location.kind === 'known';
  if (bothPlaced && certainlyReachableWithin(from, to, budgetMin)) {
    return { verdict: 'clear', constraining: true };
  }

  return {
    verdict: 'undecided',
    constraining: true,
    // Routing is offered ONLY for a pair whose ends are both properly placed. A coarse point
    // is a municipality collapsed to a dot, and a duration measured from a dot is no more
    // clearable than a straight line from one — ADR-0014's rule that coarse may refuse but
    // never clear survives having a better estimate available.
    leg: bothPlaced
      ? {
          from,
          to,
          budgetMin,
          // The drive starts when the earlier job's blocked range ends.
          departAt: side === 'before' ? neighbour.blockedEnd : candidate.blockedEnd,
        }
      : undefined,
  };
}

/**
 * The candidate's verdict, from the jobs either side of it.
 *
 * NO DAY BOUNDARY ANYWHERE. A 23:30 job and a 00:15 job are physically adjacent and are checked
 * against each other. The "same local day" framing that day-CAPACITY uses is a fact about what
 * a business sold, and has nothing to do with whether a van can cover the distance.
 *
 * The two sides are combined worst-first: a proof of impossibility on either side settles it,
 * then any absence of proof, and only a slot proven fine on both sides is `clear`.
 */
export function assessTravel(input: AssessTravelInput): TravelVerdict {
  return combine(input.candidate, [
    assessSide(input.candidate, input.before, input.slackMin, 'before'),
    assessSide(input.candidate, input.after, input.slackMin, 'after'),
  ]);
}

/** Fold two sides into one verdict. Shared so the routed path cannot combine them differently. */
function combine(candidate: TravelCandidate, outcomes: SideOutcome[]): TravelVerdict {
  const verdicts = outcomes.map((o) => o.verdict);

  if (verdicts.includes('unreachable')) return 'unreachable';
  if (verdicts.includes('undecided')) return 'undecided';

  // A COARSE CANDIDATE CAN NEVER BE CLEARED, whatever the neighbours are — including none at
  // all. The per-side rules above cannot express this on their own: with an empty day, or with
  // only phone jobs around it, both sides return `clear` and a job at an address we located
  // only to a municipality would auto-confirm and be stamped as checked. That stamp would be a
  // lie, and it would make this ticket MORE permissive than the one before it, which refused a
  // coarse address outright. The softening on offer here is refusal into Request, never
  // refusal into confirmation.
  return candidate.coarse ? 'undecided' : 'clear';
}

/**
 * The nearest preceding job THAT HAS A LOCATION: the greatest `blockedEnd` at or before the
 * candidate, ignoring jobs that constrain nothing.
 *
 * A LOCATIONLESS JOB IS TRANSPARENT, NOT A WALL, and getting this wrong is the difference
 * between a gate and a decoration. Take a Brussels job finishing at 10:00, a five-minute phone
 * call at 10:05, and a candidate in Liège at 10:15. If the phone call counts as the
 * predecessor, it has no location, so the side reads `clear` — and the gate has just confirmed
 * being in Brussels at 10:00 and Liège at 15 minutes later, because a phone call stood in
 * front of the fact. The real constraint is always the last place the owner had to BE.
 *
 * Its occupied time is deliberately NOT subtracted from the budget either. The owner could
 * take that call from the van (plan §6.6), so the honest window for the drive is the whole
 * span between the two physical jobs.
 *
 * `unresolved` is NOT transparent: a job whose location we merely failed to obtain is a
 * constraint we cannot evaluate, which is a different thing from one that does not exist.
 *
 * TWO SEARCHES, TWO ORDERINGS, and one sorted array cannot serve both — the predecessor is
 * found by end time and the successor by start time. Written as linear scans because a
 * neighbour list is the held bookings of a couple of days, and a binary search over two
 * separately-sorted copies would be more code guarding less work.
 *
 * A row that OVERLAPS the candidate is neither before nor after it, and is ignored. Overlap is
 * the exclusion constraint's business, not travel's; a slot that overlaps a held booking was
 * never offered in the first place.
 */
const constrains = (n: TravelNeighbour): boolean => n.location.kind !== 'locationless';

export function precedingNeighbour(
  neighbours: TravelNeighbour[],
  candidate: Pick<TravelCandidate, 'blockedStart'>
): TravelNeighbour | null {
  let best: TravelNeighbour | null = null;
  for (const n of neighbours) {
    if (!constrains(n)) continue;
    if (n.blockedEnd.getTime() > candidate.blockedStart.getTime()) continue;
    if (!best || n.blockedEnd.getTime() > best.blockedEnd.getTime()) best = n;
  }
  return best;
}

/** The nearest following job that has a location: the least `blockedStart` at or after the end. */
export function followingNeighbour(
  neighbours: TravelNeighbour[],
  candidate: Pick<TravelCandidate, 'blockedEnd'>
): TravelNeighbour | null {
  let best: TravelNeighbour | null = null;
  for (const n of neighbours) {
    if (!constrains(n)) continue;
    if (n.blockedStart.getTime() < candidate.blockedEnd.getTime()) continue;
    if (!best || n.blockedStart.getTime() < best.blockedStart.getTime()) best = n;
  }
  return best;
}

/**
 * How long the drive might take, for a human being to read.
 *
 * A RANGE, NOT A NUMBER, and the width of it is the honest part. Nothing has routed anything:
 * this is a straight line between two points divided by the same two speed constants the gate
 * reasons with, so the fast end assumes a motorway that may not exist and the slow end assumes
 * a crawl through town. A single figure would be a guess wearing the clothes of a measurement,
 * and the owner deciding whether to accept a job is exactly the person who must not be given
 * one of those.
 *
 * The straight line also means the true drive can exceed the slow end — a river, a ferry, a
 * closed bridge. It is a sketch to inform a decision, never an input to one. Nothing in the
 * gate reads this.
 */
export interface DriveEstimate {
  /** Straight-line distance, rounded to the kilometre. */
  km: number;
  /** At the optimistic bound: nobody beats this on public roads. */
  fastestMin: number;
  /** A plausible slow city drive — NOT the safety floor. See `DISPLAY_SLOWEST_KMH`. */
  slowestMin: number;
}

export function estimateDrive(from: GeoPoint, to: GeoPoint): DriveEstimate {
  const km = haversineKm(from, to);
  return {
    km: Math.round(km),
    fastestMin: Math.round((km / PREFILTER_MAX_KMH) * 60),
    // Deliberately NOT `PREFILTER_MIN_KMH`. That floor sits at a crawl so it never clears a
    // drive the owner cannot make; rendering it would tell them a job down the road might
    // take half an hour, which is worse than saying nothing.
    slowestMin: Math.round((km / DISPLAY_SLOWEST_KMH) * 60),
  };
}

/** Both sides at once, for a caller walking a list of candidate slots. */
export function assessSlot(input: {
  candidate: TravelCandidate;
  neighbours: TravelNeighbour[];
  slackMin: number;
}): TravelVerdict {
  return assessTravel({
    candidate: input.candidate,
    before: precedingNeighbour(input.neighbours, input.candidate),
    after: followingNeighbour(input.neighbours, input.candidate),
    slackMin: input.slackMin,
  });
}

/**
 * Ask something for a real drive time. Injected so this file stays free of HTTP and every
 * branch below is unit-testable without a network (the plan's P3 shape).
 */
export type DriveLookup = (leg: RoutableLeg) => Promise<RoutedLeg>;

/** Drive answers from one pass, so a later pass can reach the same verdict without asking again. */
export type DriveRecords = Record<string, RoutedLeg>;

/**
 * How many drives one availability check may buy, and how long it may take buying them.
 *
 * THE CACHE DOES NOT SAVE YOU HERE, and assuming it did was the mistake this exists to fix.
 * Consecutive candidate slots share both endpoints and differ only in departure time — but
 * the traffic-aware cache buckets at a quarter hour while slots are commonly half an hour
 * apart, so every slot lands in its own bucket and shares nothing. A morning of eight slots
 * with a job either side is sixteen distinct lookups, each a paid element and each a
 * round-trip a customer is sitting behind.
 *
 * Ten is the same ceiling the lazy geocode path took, for the same reason: it bounds the
 * FIRST query over a busy diary rather than trusting that a later one will be cheaper.
 */
const MAX_ROUTE_LOOKUPS_PER_CALL = 10;

/**
 * And the latency bound, because a count cap is not one.
 *
 * Ten lookups that each time out at five seconds is fifty seconds of silence in a chat
 * window, and that happens exactly when Google is unreachable — when every one of them was
 * going to fail anyway. Like the geocode deadline this bounds when the LAST lookup may
 * START, so the real ceiling is this plus one client timeout. Racing an in-flight request
 * against a timer would abandon a call Google has already been paid for.
 */
const ROUTE_LOOKUP_DEADLINE_MS = 8_000;

export interface RouteBudget {
  remaining: number;
  deadline: number;
}

/** One budget per availability check, shared by every slot in it. */
export function routeBudget(): RouteBudget {
  return { remaining: MAX_ROUTE_LOOKUPS_PER_CALL, deadline: Date.now() + ROUTE_LOOKUP_DEADLINE_MS };
}

/** Spend one, or report that there is nothing left to spend. */
function claimRouteBudget(budget: RouteBudget): boolean {
  if (budget.remaining <= 0 || Date.now() >= budget.deadline) return false;
  budget.remaining -= 1;
  return true;
}

/** Identity of a leg: both ends at ~11 m, and the minute the van leaves. */
export function legKey(leg: RoutableLeg): string {
  const p = (v: number): string => v.toFixed(5);
  return `${p(leg.from.lat)},${p(leg.from.lng)}|${p(leg.to.lat)},${p(leg.to.lng)}|${leg.departAt.getTime()}`;
}

/** Wrap a lookup so everything it answers is kept. */
export function recordingLookup(inner: DriveLookup, into: DriveRecords): DriveLookup {
  return async (leg) => {
    const answer = await inner(leg);
    into[legKey(leg)] = answer;
    return answer;
  };
}

/**
 * Answer ONLY from what a previous pass recorded, and never reach for the network.
 *
 * This is what lets the in-lock assert re-reach a routed verdict without calling Google
 * inside a transaction — the pattern `internal.provider` already warns about, because
 * holding a pool connection open across someone else's network call is how a booking spike
 * becomes an outage.
 *
 * A MISS IS A REFUSAL, and that is the whole safety property. The snapshot is keyed on the
 * neighbour's position and the departure minute, so if the diary moved under the lock the
 * legs no longer match, the lookup goes quiet, and the slot falls back to undecided — which
 * the assert treats as "check availability again". A miss can only ever cost a retry; a
 * silent fall-through to the bounds would confirm a drive nobody measured.
 */
export function replayLookup(records: DriveRecords): DriveLookup {
  return async (leg) => records[legKey(leg)] ?? { minutes: null };
}

/** What a lookup can come back with. `null` minutes means it could not answer. */
export interface RoutedLeg {
  /** Minutes for the drive, or null when routing was unavailable. */
  minutes: number | null;
  /** Routing looked and there is no drivable route at all — a definite no. */
  noRoute?: boolean;
  /**
   * WHY it could not answer, when it could not.
   *
   * Carried rather than collapsed because the responses differ and #68 is required to tell
   * them apart: a spent cap is one tenant's problem and a revoked key is everybody's. This is
   * the only place in the system where that distinction exists — the column records only THAT
   * a booking degraded, never why — so discarding it here would leave the alert with nothing
   * to key on but a count.
   */
  cause?: string;
}

export interface RoutedAssessment {
  verdict: TravelVerdict;
  /**
   * Did routing answer EVERY leg that constrained this verdict?
   *
   * This is what licenses `travel_check='ok'`, and it is deliberately all-or-nothing. A slot
   * cleared by a real drive time on one side and by the haversine floor on the other has not
   * been "verified against routing" in the sense `CONTEXT.md` defines, and calling it `ok`
   * would make the word mean two different things depending on what the diary happened to
   * look like — which #68's alert would then inherit.
   */
  fullyRouted: boolean;
  /**
   * Distinct reasons a leg went unanswered, in the order they were met. Empty when routing
   * answered everything, or when nothing needed asking. Not persisted — #68's to consume.
   */
  degradedCauses: string[];
}

/**
 * The same verdict, with the undecided band resolved by real drive times.
 *
 * ONLY THE BAND IS ROUTED. A leg the bounds already settled is not looked up, a leg with a
 * coarse end is not looked up, and a leg whose neighbour we could not place has nothing to
 * look up. That restraint is the cost model, and it is measured: about four in five realistic
 * Belgian pairs land in the band, so the calls this skips are the difference between a bill
 * that is noise and one that is not.
 *
 * A LOOKUP THAT CANNOT ANSWER LEAVES THE LEG EXACTLY AS IT WAS — undecided. That is
 * ADR-0015's degraded branch reached by doing nothing rather than by a special case: the
 * bounds already refused the certain-nos and cleared the certain-yeses before we got here, so
 * an outage simply means the middle stays a Request, which is precisely the behaviour that
 * shipped before this function existed.
 */
export async function assessSlotRouted(input: {
  candidate: TravelCandidate;
  neighbours: TravelNeighbour[];
  slackMin: number;
  lookup: DriveLookup;
  /**
   * Shared across every slot of one availability check — see `routeBudget`. Omitted means
   * unbounded, which is right for the single-slot create path and wrong for a list.
   */
  budget?: RouteBudget;
}): Promise<RoutedAssessment> {
  const outcomes = [
    assessSide(input.candidate, precedingNeighbour(input.neighbours, input.candidate), input.slackMin, 'before'),
    assessSide(input.candidate, followingNeighbour(input.neighbours, input.candidate), input.slackMin, 'after'),
  ];

  const resolved: SideOutcome[] = [];
  // A leg the bounds settled counts against `fullyRouted` — see RoutedAssessment.
  let routedEvery = true;
  const causes = new Set<string>();

  for (const outcome of outcomes) {
    if (outcome.verdict !== 'undecided' || !outcome.leg) {
      if (outcome.constraining && outcome.verdict !== 'undecided') {
        // Settled by the bounds, so nothing was unavailable — it simply was not measured.
        routedEvery = false;
        causes.add('settled_by_bounds');
      }
      resolved.push(outcome);
      continue;
    }

    // Checked BEFORE each lookup, so a spent budget degrades exactly like an outage rather
    // than half-answering a slot list. The remaining slots stay undecided, which withholds
    // them into Requests — the safe direction.
    if (input.budget && !claimRouteBudget(input.budget)) {
      routedEvery = false;
      causes.add('budget_spent');
      resolved.push(outcome);
      continue;
    }

    const answer = await input.lookup(outcome.leg);
    if (answer.noRoute) {
      // Routing looked and there is no way to drive it. A fact about the pair, so it refuses.
      resolved.push({ verdict: 'unreachable', constraining: true });
      continue;
    }
    if (answer.minutes === null || !Number.isFinite(answer.minutes)) {
      // Degraded: leave it exactly where the bounds left it, but keep WHY.
      routedEvery = false;
      causes.add(answer.cause ?? 'unknown');
      resolved.push(outcome);
      continue;
    }
    resolved.push({
      verdict: answer.minutes <= outcome.leg.budgetMin ? 'clear' : 'unreachable',
      constraining: true,
    });
  }

  const verdict = combine(input.candidate, resolved);
  // `ok` is only ever a claim about a CLEARED slot. A refusal needs no such stamp, and an
  // undecided one is a Request by definition.
  return { verdict, fullyRouted: verdict === 'clear' && routedEvery, degradedCauses: [...causes] };
}
