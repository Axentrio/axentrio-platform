/**
 * A drive time with no API behind it.
 *
 * `DriveLookup` is a function type, so the gate never learns where an answer came from. This is
 * the implementation that comes from arithmetic instead of Google: straight-line distance, a
 * detour allowance for the fact that roads are not straight, a speed, and a fixed overhead for
 * the part of every journey that is not driving.
 *
 * ## What it is for, and what it is not for
 *
 * It exists so the platform keeps working when Google does not - a 36-hour Geocoding incident and
 * a 24-hour Distance Matrix incident are both in the last year's record - and so a deployment
 * without a Maps key is a degraded platform rather than a broken one.
 *
 * Every answer it produces is DEGRADED, and that word is load-bearing. An estimate may RANK slots,
 * because being roughly right is enough to prefer the nearer of two jobs. It may never REFUSE one.
 * The measured spread below is the reason: this model is decent on average and badly wrong on
 * exactly the journeys that matter, and a refusal built on it would turn a real appointment away
 * on the strength of a guess.
 *
 * ## Why a straight line is not a drive
 *
 * Two effects, in opposite directions, and both are documented in `contracts/travel.ts` from
 * measurements taken against live Routes in August 2026:
 *
 *   - Roads detour. European detour coefficients average about 1.3 and range from 1.08 to 1.88 by
 *     city, so no constant is tight - it is an average standing in for a distribution.
 *   - Short journeys are dominated by fixed costs rather than distance. Ten short urban pairs
 *     across Antwerp, Brussels, Ghent and Mechelen came in between 2.0 and 14.3 km/h effective,
 *     against 24 to 51 for ten intercity pairs. The worst case was 550 metres taking 16.7 minutes,
 *     because the Scheldt is in the way and you drive under it.
 *
 * A single average speed cannot express both. An overhead plus a rate can, which is why the model
 * below has two terms - and `contracts/travel.ts` predicted exactly this shape before anybody
 * built it: "effective speed climbs with distance, so a fixed overhead plus a rate would fit far
 * better than any constant".
 *
 * ## These numbers are a starting point, not a result
 *
 * They are reasoned from the measurements above rather than fitted to them, and the honest way to
 * settle them is to compare this against live Google over real pairs. `scripts/compare-drive-
 * estimates.ts` does that. Treat any value here as provisional until that has been run.
 */
import { haversineKm, type GeoPoint } from '../../contracts/travel';
import type { DriveLookup } from './travel-gate';

/**
 * Roads are longer than straight lines. 1.3 is the European average detour coefficient.
 *
 * It is an average standing in for a range of 1.08 to 1.88, so it is systematically wrong for any
 * particular city - generous in a grid, mean where a river or a ring road forces a long way round.
 */
export const DETOUR_FACTOR = 1.3;

/**
 * Everything that is not covering ground: leaving a parking space, junctions, finding the door.
 *
 * SEVENTEEN MINUTES LOOKS ABSURD AND IS MEASURED. A least-squares fit against live Google over
 * fourteen Belgian pairs put the intercept at 17.4 minutes and the rate at 96.8 km/h. The first
 * version of this file guessed 4 and 45, reasoning from cruising speeds, and produced a 47% mean
 * absolute error - every short hop under-estimated by 39-72%, every long one over-estimated by
 * 49-95%, with the two biases cancelling into a flattering +10% mean that meant nothing.
 *
 * The shape is what `contracts/travel.ts` predicted: fixed costs dominate short journeys so
 * completely that the honest intercept is most of a short drive. 550 metres under the Scheldt
 * takes 16.7 minutes, and this model now says 18 rather than 5.
 */
export const FIXED_OVERHEAD_MIN = 17;

/**
 * The RATE at which extra straight-line distance turns into extra minutes - not a driving speed.
 *
 * 95 km/h against a 120 limit looks fast until you notice the seventeen-minute intercept is
 * already carrying everything slow. Once a journey is long enough for the intercept to stop
 * dominating, Belgian motorway travel really does add distance at close to this rate. Fitted, not
 * chosen: the naive 45 km/h it replaced over-estimated an Antwerp-Bruges drive by 80%.
 */
export const ESTIMATED_KMH = 95;

/**
 * How much to inflate an estimate before letting it decide whether a slot is reachable.
 *
 * The measurement is the whole justification. Against live Google over fourteen Belgian journeys
 * the tuned model came in 16% out on average and erred LONG on nine of them - but one leg came
 * back 22% SHORT, a 67 minute drive it called 52. Under-stating is the direction that authorises a
 * booking the owner cannot make, so the padding has to cover the worst under-statement seen, with
 * something in hand.
 *
 * 1.3 covers that 22% and leaves margin for a route worse than any in the sample. It is not free:
 * a padded estimate refuses to clear slots the owner could genuinely have made, and those become
 * Requests they confirm by hand. That is the correct direction to be wrong in - a Request costs a
 * click, a missed appointment costs a customer.
 *
 * Applied ONLY when an estimate decides reachability. Ranking uses the raw number, because
 * inflating both sides of a comparison changes nothing about which is nearer.
 */
export const FEASIBILITY_PADDING = 1.3;

/** Minutes for one leg, from geometry alone. Exported so a comparison can call it directly. */
export function estimateDriveMinutes(from: GeoPoint, to: GeoPoint): number {
  const km = haversineKm(from, to) * DETOUR_FACTOR;
  // Rounded UP, like the Routes parser: rounding a drive down is the direction that authorises a
  // booking the owner cannot make.
  return Math.ceil(FIXED_OVERHEAD_MIN + (km / ESTIMATED_KMH) * 60);
}

/**
 * A `DriveLookup` that never calls anything.
 *
 * The gate is handed a function and never learns where the answer came from, so this substitutes
 * for Google without anything upstream knowing - which is what makes the routing provider a
 * configuration choice rather than an architectural one.
 *
 * `estimated: true` is the whole contract. It lets the gate CLEAR a slot on this number but never
 * REFUSE one, and it keeps `travel_check` off `ok` for a journey nobody measured. Both follow from
 * the measurement in `scripts/compare-drive-estimates.ts`: 16% mean absolute error, erring long on
 * nine legs in fourteen, with one still 22% short. Long enough to trust a fit; short enough on one
 * leg in fourteen that a refusal would eventually turn away a real customer.
 *
 * It is deliberately NOT the default. Google measures roads; this measures a straight line and
 * multiplies. This exists so an outage, a spent cap or a missing key degrades the platform instead
 * of stopping it.
 */
export function haversineDriveLookup(opts?: { padded?: boolean }): DriveLookup {
  return async (leg) => ({
    // Padded by default: this lookup is reached when Google could not answer, which is exactly
    // when a wrong answer is least likely to be caught by anything else.
    minutes: Math.ceil(
      estimateDriveMinutes(leg.from, leg.to) * (opts?.padded === false ? 1 : FEASIBILITY_PADDING)
    ),
    estimated: true,
    // Distinct from the failure causes so the health monitor can tell "we chose not to ask" from
    // "we asked and could not get an answer". #68 keys on these.
    cause: 'estimated',
  });
}
