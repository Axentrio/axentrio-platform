/**
 * What grouping is allowed to spend (#81).
 *
 * ALMOST FREE, and the "almost" is the whole design. Grouping reads this conversation's drive
 * cache for the two legs beside a candidate, because those are exactly the pairs the feasibility
 * gate just routed - they cost nothing. It has to BUY one kind of leg and only one: the baseline
 * `prev→next`, which says what the day cost without this candidate. Nothing else in the system
 * ever needs it, so it is never in the cache and no amount of waiting will put it there.
 *
 * A first cut spent nothing at all, and it was measured: 10 offers, 63 slots, and every slot it
 * managed to score had a neighbour on ONE side only. A candidate BETWEEN two jobs needs the
 * baseline, missed it every time, and went neutral - so the scorer was blind to precisely the
 * mid-day insertion that grouping exists to find, and `cheaperAlternativeExisted` read false on
 * every offer for a structural reason rather than a real one.
 *
 * The bill stays small because the baseline is per-GAP, not per-candidate: same two anchors, same
 * departure instant, so every candidate in a gap reads one purchase. A day with three jobs has two
 * internal gaps. `GROUPING_PAID_LEG_BUDGET` is the hard stop for one pass regardless.
 *
 * The other two bounds are about the customer waiting behind a live availability call rather than
 * about the bill: how many legs the pass reads at all, and how long it may take.
 */
/**
 * How long a scoring pass may take before the caller stops waiting for it.
 *
 * WHAT THIS DOES AND DOES NOT BOUND, stated exactly, because a race abandons the wait rather than
 * the work. Past the deadline no further leg is read and no reservation is BEGUN - the bound
 * reaches the purchase itself, not merely the decision to look. It cannot unwind a reservation
 * already awaiting or cancel a request already in flight; a check-then-act cannot promise that,
 * and neither can anything else here. Those finish on their own, bounded by the router's 5-second
 * timeout, and their answers land in the drive cache rather than being wasted.
 */
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
 * The most legs one scoring pass may BUY, as opposed to read from cache.
 *
 * Four, which is four internal gaps - a five-job day. Past that the pass stops buying and the
 * remaining candidates go neutral, which is the ordinary "no opinion" outcome and refuses nothing.
 *
 * Deliberately a hard per-pass count and NOT a share of the tenant's month. A fractional share was
 * the first design and it was rejected: grouping and feasibility draw on one counter, so a share
 * bounds the harm without removing it, and there is no fraction at which "this optional thing can
 * push a tenant into an exhaustion they would not otherwise reach" becomes acceptable. What makes
 * this version defensible is not the ceiling, it is the magnitude - single figures per
 * conversation, shaped by the diary rather than by the length of the slot list.
 */
export const GROUPING_PAID_LEG_BUDGET = 4;
