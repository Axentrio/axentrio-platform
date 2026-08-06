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
  type GeoPoint,
} from '../../contracts/travel';

/**
 * `unreachable` and `clear` are PROOFS; `undecided` is the absence of one.
 *
 * Named for what is known rather than for what to do about it, because the two callers do
 * different things with the same verdict: availability withholds an `undecided` slot from the
 * confirmable list, create turns it into a Request.
 */
export type TravelVerdict = 'clear' | 'unreachable' | 'undecided';

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
): TravelVerdict {
  // Nothing parked on this side, so there is no drive to fit. The day being empty is the one
  // case where travel time genuinely has nothing to say.
  if (!neighbour) return 'clear';
  if (neighbour.location.kind === 'locationless') return 'clear';
  if (neighbour.location.kind === 'unresolved') return 'undecided';

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
  if (!couldReachWithin(from, to, budgetMin)) return 'unreachable';

  // Certain the other way, and this requires BOTH ends to be properly placed. A town centre on
  // either end would be clearing a drive between two dots rather than between two doors.
  if (
    !candidate.coarse &&
    neighbour.location.kind === 'known' &&
    certainlyReachableWithin(from, to, budgetMin)
  ) {
    return 'clear';
  }

  return 'undecided';
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
  const verdicts = [
    assessSide(input.candidate, input.before, input.slackMin, 'before'),
    assessSide(input.candidate, input.after, input.slackMin, 'after'),
  ];

  if (verdicts.includes('unreachable')) return 'unreachable';
  if (verdicts.includes('undecided')) return 'undecided';

  // A COARSE CANDIDATE CAN NEVER BE CLEARED, whatever the neighbours are — including none at
  // all. The per-side rules above cannot express this on their own: with an empty day, or with
  // only phone jobs around it, both sides return `clear` and a job at an address we located
  // only to a municipality would auto-confirm and be stamped as checked. That stamp would be a
  // lie, and it would make this ticket MORE permissive than the one before it, which refused a
  // coarse address outright. The softening on offer here is refusal into Request, never
  // refusal into confirmation.
  return input.candidate.coarse ? 'undecided' : 'clear';
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
