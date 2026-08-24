/**
 * Travel placement gates that decide whether a job may be AUTO-CONFIRMED.
 *
 * Deliberately a separate module from service-area-gate.ts: the area asks "is
 * this town on the owner's list" while this asks "where is the door", and both
 * throw the same recoverable code on purpose - the prompt's recovery ("ask for
 * a postcode, else capture with request_appointment") is exactly right for
 * both, and a second code would need the model taught twice.
 */
import {
  blocksAutoConfirm,
  placementIsCoarse,
  type BookingPlacement,
} from '../travel/booking-place';
import type { GeoPoint } from '../../contracts/travel';
import { BookingError } from './types';

/**
 * Travel time: don't AUTO-CONFIRM a job we cannot locate well enough to plan the drive to.
 *
 * A SEPARATE GATE FROM THE SERVICE AREA, and the difference is worth stating because the two
 * throw the same code. The area asks "is this town on the owner's list", which the Belgian
 * municipality table answers for free from the address text. This asks "where is the door",
 * which only Google can answer, so a street the area gate matched to Sint-Niklaas can still
 * be unplaceable here, and a business with no area configured at all is still gated once
 * travel is on.
 */
export function assertPlaceableForTravel(placement: BookingPlacement): void {
  if (!blocksAutoConfirm(placement)) return;
  throw new BookingError(
    'That address could not be located precisely enough to plan the journey. Ask for a postcode or town.',
    'ADDRESS_NOT_PLACEABLE',
    400,
    undefined,
    // "Ask for a postcode" is an instruction to the bot. A customer on the manage page cannot
    // change the address on their existing booking, so they are told who can.
    'We could not work out the journey to your address. Please contact the business directly to move this appointment.'
  );
}

/**
 * Travel time: we could not find out where anything is, so nothing here may be confirmed.
 *
 * NOT the customer's fault and NOT recoverable by them — Google was unreachable, or the
 * tenant's element cap is spent. Asking for a postcode would be friction that could not
 * possibly help, so this reuses the code the calendar outage already raises: the prompt's
 * coaching for it is exactly right ("do not say there are no slots, capture their preferred
 * time as a request"), and inventing a second code would mean teaching the model the same
 * lesson twice. Which failure it was is in the logs, where a sustained run of it belongs.
 */
export function throwTravelUnavailable(): never {
  throw new BookingError(
    'The journey could not be checked right now, so times cannot be confirmed. Ask the customer for their preferred date and time and capture it with request_appointment.',
    'BOOKING_TEMPORARILY_UNAVAILABLE',
    503
  );
}

/**
 * A placement turned into the point the gate reasons over, or a refusal.
 *
 * THE THREE OUTCOMES OF #62 BECOME THE THREE BRANCHES OF ADR-0015 HERE, and this is the only
 * place that mapping exists. An address we could not place at all has a recovery the customer
 * can act on. An address placed only to a town centre is a usable point that may refuse and may
 * never clear. An outage is neither, and refuses to confirm anything without pretending the
 * customer typed something wrong.
 */
export function travelCandidatePoint(placement: BookingPlacement): { point: GeoPoint; coarse: boolean } {
  assertPlaceableForTravel(placement);
  if (!placement.applies || placement.outcome !== 'placed') throwTravelUnavailable();
  return {
    point: { lat: placement.place.lat, lng: placement.place.lng },
    coarse: placementIsCoarse(placement),
  };
}
