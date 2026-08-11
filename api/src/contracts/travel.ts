/**
 * Travel time between two jobs — the arithmetic, and nothing else.
 *
 * THE PROBLEM. A 10:00–10:30 job at X and a 10:30–11:00 job at Y were both bookable no
 * matter how far apart X and Y are, because the only thing standing between two
 * appointments was `BookingSettings.minGapMin` — one flat number for the whole business.
 * A flat gap cannot be right twice: set it to 30 and every next-door job wastes half an
 * hour, set it to 5 and the cross-country one is impossible the moment it is confirmed.
 *
 * WHAT THIS FILE IS. Pure functions over coordinates and minutes. No HTTP, no DB, no
 * Google. `service-timing.ts` and `event-location.ts` exist separately for exactly this
 * reason: importing the travel gate from `internal.provider` must not drag the entity graph
 * (and a live DB connection) into a test that only wants to check the sums.
 *
 * WHICH WAY IT FAILS. Every unknown here degrades to the flat gap, never to a refusal. An
 * un-geocodable address, a neighbouring job at no fixed address, a Routes API outage — all
 * of them mean "this file has nothing to add", and the caller falls back to the behaviour
 * the platform had before travel time existed. A false refusal costs a real customer a real
 * booking; a false allow costs the owner the same rushed drive they already have today.
 */

/** WGS84, as Google returns and as we store on a booking. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * How precisely Google placed an address — and therefore whether we believe it.
 *
 * This is load-bearing, not metadata. `APPROXIMATE` is what a bare city name resolves to:
 * a centroid that can sit kilometres from the real door. Gating a 30-minute drive on a
 * point that vague authorises slots that are physically impossible, so it is treated as
 * NOT KNOWN rather than as a location — see `isTrustedForTravel`.
 */
export type GeocodePrecision = 'rooftop' | 'range_interpolated' | 'geometric_center' | 'approximate';

/**
 * A precision we will let decide a booking. `approximate` is deliberately excluded: it is
 * recorded on the row (so the owner and any later audit can see what we had) but it never
 * drives the gate.
 */
export function isTrustedForTravel(precision: GeocodePrecision | null | undefined): boolean {
  return precision === 'rooftop' || precision === 'range_interpolated' || precision === 'geometric_center';
}

/**
 * How a location was obtained, which is a different question from how precise it is.
 *
 * `geocoded` is a string we sent to Google. `pin` is the customer tapping their own location,
 * which arrives already placed and skips forward-geocoding ambiguity entirely. Typed here
 * beside `GeocodePrecision` rather than inline at each use, for the same reason: provenance
 * decides trust, so the column and the code that reads it must not be able to drift apart.
 */
export type LocationSource = 'pin' | 'geocoded';

/** Mean Earth radius (km), IUGG. */
const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance in km. Used ONLY as a lower bound — see `couldReachWithin`.
 *
 * Straight-line distance is never the answer to "how long is the drive", but it is a
 * guaranteed underestimate of it, and that one-sidedness is what makes it safe to
 * pre-filter with.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * TWO BOUNDS, POINTING OPPOSITE WAYS.
 *
 * Both pre-filters below exist to avoid spending an API element on a pair whose answer is
 * already certain. But "certainly too far" and "certainly close enough" are not the same
 * question, and they CANNOT share a speed constant — an earlier draft used one for both
 * and waved a 47 km intercity pair through a 60-minute gap, on the reasoning that a
 * straight line at motorway speed fits. The real drive is about fifty minutes plus
 * parking. It did not fit.
 *
 * So: each filter gets the speed that makes ITS answer one-sided.
 *
 * `MAX_KMH` — nobody beats this on public roads, so failing it is conclusive.
 * `MIN_KMH` — a measured floor on effective straight-line speed. NOT conclusive; see below.
 *
 * Moving MAX up, or MIN down, only ever costs API calls. Moving MAX down, or MIN up, is
 * what silently authorises an impossible booking.
 */
export const PREFILTER_MAX_KMH = 120;

/**
 * A MEASURED FLOOR, NOT A THEOREM — and it was 20 until live data said otherwise.
 *
 * Straight-line distance does not bound drive time from below in any useful way, because
 * what governs a short drive is topology rather than distance. The case that settled it:
 * Sint-Jansvliet to Frederik van Eedenplein in Antwerp is **550 metres apart and a 16.7
 * minute drive**, because the Scheldt is in between and you go under it. That is 2.0 km/h
 * effective. At the old 20 the bound "proved" a 1.65 minute fit, so every gap from about
 * 1.7 to 16.7 minutes was cleared for a drive the owner could not make — and ordinary
 * business minimum gaps sit at 5 to 15.
 *
 * Ten short urban pairs were measured against live Routes across Antwerp, Brussels, Ghent
 * and Mechelen (2026-08-07). **Every one came in under 20 km/h**; the range was 2.0 to 14.3.
 * Ten longer intercity pairs came in at 24 to 51, so the failure is specific to short hops,
 * where fixed costs — one-way systems, pedestrian cores, a river — dominate the distance.
 *
 * 1 sits at twice the margin under the worst case seen, which is the most that can honestly
 * be claimed for it. It still does the job the branch exists for: at a 30 minute gap it
 * clears anything within 500 m, at 60 minutes within a kilometre.
 *
 * TWO THINGS A READER SHOULD NOT ASSUME. The shape is wrong as well as the number —
 * effective speed climbs with distance, so a fixed overhead plus a rate would fit far
 * better than any constant, and no constant can be made tight. And this is not the only
 * thing between two jobs: `travel-gate.ts` subtracts the owner's slack from the gap BEFORE
 * calling either bound, so parking and the doorstep are already out of the budget by the
 * time this runs.
 */
export const PREFILTER_MIN_KMH = 1;

/**
 * The slow end of a drive estimate SHOWN TO A PERSON — deliberately not the safety floor.
 *
 * These were one constant until the floor had to drop to 1, and that exposed them as two
 * jobs wearing one number. A floor decides whether to clear a booking, so being far too
 * pessimistic costs only an API call. A displayed range is read by an owner deciding whether
 * to accept a captured Request, and "up to 30 minutes" for a job 500 metres away is not
 * cautious, it is useless — they stop reading the number at all.
 *
 * 20 km/h is what the pair used to share, so the estimate an owner sees is unchanged. It is
 * a plausible slow city speed rather than a bound, and it can understate a barrier crossing
 * exactly as badly as the floor did; that is acceptable here because nothing is decided on
 * it. Once routing is available the real duration replaces this, and it survives only as the
 * degraded-mode fallback.
 */
export const DISPLAY_SLOWEST_KMH = 20;

/**
 * Could a driver possibly cover `from`→`to` in `minutes`, ignoring roads and traffic?
 *
 * `false` is CERTAIN: not even a straight line at motorway speed fits, so no routing
 * answer will fit either and the slot can be rejected without spending an API element.
 * `true` is only "maybe" — the real drive may still be longer, so a `true` here means
 * ASK GOOGLE, not "allow".
 */
export function couldReachWithin(from: GeoPoint, to: GeoPoint, minutes: number): boolean {
  if (minutes <= 0) return haversineKm(from, to) === 0;
  return haversineKm(from, to) <= (PREFILTER_MAX_KMH * minutes) / 60;
}

/**
 * The mirror image: is this pair so close that the gap suffices even on the worst drive we
 * have ever measured?
 *
 * `true` IS NOT A PROOF, and the name overstates it — kept only because renaming it would
 * churn every call site for no change in behaviour. It says the pair clears a floor
 * calibrated against real Belgian drives, which is a strong bet and not a certainty: no
 * constant speed can be conclusive when a river or a pedestrian core decides the route. See
 * `PREFILTER_MIN_KMH`, which records the measurement and the case that falsified the old one.
 *
 * `false` means ask Google — and once routing exists, a `true` here is the cheaper answer
 * rather than the better one. The branch earns its place mainly in DEGRADED mode, where
 * routing is unreachable and the alternative to a calibrated bet is no answer at all.
 */
export function certainlyReachableWithin(from: GeoPoint, to: GeoPoint, minutes: number): boolean {
  if (minutes <= 0) return false;
  return haversineKm(from, to) <= (PREFILTER_MIN_KMH * minutes) / 60;
}

/** What the caller knows about the gap between one job and the next. */
export interface TravelGapInput {
  /**
   * Routing's answer in minutes, or null when there isn't one — no coordinates on either
   * side, an untrusted geocode, or the Routes API was unreachable. Null is the
   * degrade-to-flat-gap signal and is a NORMAL outcome, not an error.
   */
  driveMin: number | null;
  /** The owner's safety margin on top of the drive: parking, the doorstep, overrunning. */
  slackMin: number;
  /** The business's existing flat gap. Stays the floor — travel raises it, never lowers it. */
  minGapMin: number;
}

/**
 * How many free minutes must sit between two consecutive jobs.
 *
 * THE FLAT GAP IS A FLOOR, NOT A TERM IN A SUM. `minGapMin` is the owner's stated
 * breathing room — they set it for reasons that have nothing to do with distance
 * (a coffee, notes, a phone call), and a two-minute drive must not silently cancel it.
 * So the answer is the LARGER of the flat gap and the drive-plus-slack, which means:
 *
 * (Do not read "additive" here. The Minimum Gap is additive with a Service's BUFFERS —
 * those sit inside `blocked_range` and this gap is measured between blocked ranges, so
 * the two compose by addition. Drive time composes with the flat gap by `max`.)
 *
 *   - no routing answer  → exactly today's behaviour, `minGapMin`
 *   - a short drive      → still `minGapMin`, unchanged
 *   - a long drive       → the drive, plus the owner's slack
 *
 * Slack is added only when there IS a drive to pad. Adding it to the null case would
 * quietly tighten every business that never uses this feature.
 *
 * ## NOTHING CALLS THIS, AND THAT IS CORRECT
 *
 * This states the invariant; it does not enforce it. The enforcement is split across two
 * mechanisms that never meet, and folding them into one call would double-apply the gap:
 *
 *   - `min_gap_min` is a Capacity Ceiling, applied when SLOTS ARE GENERATED, so a slot list
 *     already has the owner's flat gap between its entries before travel sees it.
 *   - the drive is applied by the FEASIBILITY GATE, which asks whether the drive fits in the
 *     free time that is actually there: `budgetMin = gapMin - slackMin` (`travel-gate.ts:158`),
 *     i.e. `drive + slack <= gap`.
 *
 * Compose those and a slot survives exactly when `gap >= max(minGap, drive + slack)`, which is
 * this function. So it is a SPECIFICATION, kept and tested because the rule is easy to get wrong
 * and hard to read off two files - and it must stay uncalled, because calling it in either place
 * would charge the owner twice for one cushion.
 *
 * If you are here because you want to use it: you almost certainly want `travel-gate.ts` instead.
 */
export function travelGapMinutes(input: TravelGapInput): number {
  const floor = Math.max(0, input.minGapMin);
  if (input.driveMin === null || !Number.isFinite(input.driveMin) || input.driveMin < 0) return floor;
  return Math.max(floor, input.driveMin + Math.max(0, input.slackMin));
}

/**
 * Cache key for one origin→destination lookup.
 *
 * Rounded to ~11 m (5 decimal places). Two customers in the same building must not each
 * cost an API element, and a drive time is not sensitive to a house number. Rounding
 * further would start merging genuinely different addresses on a long street.
 */
export function travelCacheKey(from: GeoPoint, to: GeoPoint, mode: string): string {
  const r = (n: number): string => n.toFixed(5);
  return `travel:${mode}:${r(from.lat)},${r(from.lng)}:${r(to.lat)},${r(to.lng)}`;
}
