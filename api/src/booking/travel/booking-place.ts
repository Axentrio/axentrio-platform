/**
 * Turning a Booking's address into a placed address, and deciding when we are allowed to ask.
 *
 * `geocoding.service.ts` knows Google and nothing about bookings. This file knows bookings
 * and nothing about HTTP. The split is what lets the client be tested with a mocked axios
 * and lets the gates be tested without one.
 *
 * WHO PAYS, AND WHEN. An element is only ever spent for a Service that asks for the
 * customer's address, on an Agent that passed all four gates from `travel-eligibility.ts`,
 * for a Tenant that has not spent its month. A phone consultation, an Agent with the switch
 * off, a platform with no Maps key: none of them reach Google, and none of them behave any
 * differently from how they did before travel time existed. Both entry points below take
 * `ActiveTravelEligibility` rather than a tenant id, so that sentence is enforced by the
 * compiler and not by this paragraph.
 *
 * TWO ENTRY POINTS, DIFFERENT LIFECYCLES. `placeBookingAddress` runs while a booking is
 * being written, so it answers with something the INSERT can carry. `placeExistingBooking`
 * runs against a row that already exists — one whose coordinates are absent or have aged out
 * — and it refreshes by the durable identity and writes back. There is no backfill job on
 * purpose (plan §6.10): resolving lazily never geocodes history nobody will query, and it
 * self-limits to the bookings that matter.
 *
 * WHICH ENTRY POINT IS A QUESTION ABOUT THE ADDRESS, NOT ABOUT THE CALLER. A string a
 * customer just typed is placed by text, because there is nothing else to place it by. An
 * address already on a row is placed by its `place_id`, because the same words can resolve
 * somewhere else months later and a confirmed appointment would move without anybody
 * touching it. Reschedule is the case that makes this concrete: the job has not moved, only
 * the time, so re-reading the typed words would be asking a question nobody asked.
 *
 * THE THREE QUESTIONS CALLERS ASK are the three predicates at the bottom, and they are here
 * rather than at the call sites deliberately. Each is one reading of the same placement, the
 * readings disagree (an outage refuses nothing but still records something), and a copy of
 * that cascade living in the booking provider is how the two paths drift apart.
 */
import { AppDataSource } from '../../database/data-source';
import { Booking } from '../../database/entities/Booking';
import type { ServiceType } from '../../database/entities/ServiceType';
import { isTrustedForTravel, type LocationSource, type GeocodePrecision } from '../../contracts/travel';
import { logger } from '../../utils/logger';
import { resolveTravelEligibility, type ActiveTravelEligibility } from './travel-eligibility';
import { geocodeAddress, resolvePlaceId, isUsablePlace, type PlacedAddress } from './geocoding.service';
import type { ItineraryKey } from '../../scheduler/itinerary-key';

/**
 * What happened when we tried to place a booking's address.
 *
 * `applies: false` is not a failure and not a fourth outcome. It is the state every Agent on
 * the platform is in today, and it must be indistinguishable from the world before this
 * feature existed.
 *
 * Note there is no `trusted` flag: trust is a function of `place.precision` and deriving it
 * twice is how the two derivations come to disagree. `placementIsTrusted` is the one reading.
 */
export type BookingPlacement =
  | { applies: false }
  | { applies: true; outcome: 'placed'; place: PlacedAddress }
  | { applies: true; outcome: 'not_placeable' }
  | { applies: true; outcome: 'unavailable' };

/**
 * Place the address a booking is about to be written with.
 *
 * Never throws. Whether an unplaceable address stops the booking is the CALLER's decision
 * and the two callers answer differently on purpose: the auto path refuses to confirm a job
 * it cannot locate, and the request path records the same verdict without enforcing it.
 * Capturing an unplaceable job is correct; capturing it silently is not.
 */
import { serviceNeedsCustomerAddress } from '../service-location';

export async function placeBookingAddress(input: {
  tenantId: string;
  botId: string;
  itineraryKey: ItineraryKey;
  service: Pick<ServiceType, 'customerAddressRequired' | 'customerChoosesLocation' | 'locationType'>;
  address: string | null;
  /** Set when the Booking Customer picked the address rather than typing it. */
  placeId?: string | null;
  locationChoice?: 'business' | 'customer';
}): Promise<BookingPlacement> {
  // Cheapest gate of all, and it is not in `resolveTravelEligibility` because it is a fact
  // about the SERVICE rather than about the Agent: an online consultation is never a travel
  // job, however the Agent is configured. #149: a choose-at-booking Service only travels
  // when the customer picked their own location.
  if (!serviceNeedsCustomerAddress(input.service, {
    locationChoice: input.locationChoice,
    customerAddress: input.address,
  })) {
    return { applies: false };
  }
  if (!input.address?.trim()) return { applies: false };

  const eligibility = await resolveTravelEligibility({
    tenantId: input.tenantId,
    botId: input.botId,
    // Resolved once by the booking path and handed down, never re-derived here (ADR-0016).
    itineraryKey: input.itineraryKey,
  });
  if (!eligibility.active) return { applies: false };

  return placeAddressFor(eligibility, input.address, input.placeId);
}

/**
 * The same placement, for a caller that has already resolved the gates.
 *
 * The travel gate needs the eligibility itself — the itinerary key to scope neighbours by, and
 * the owner's slack — so re-deriving it inside `placeBookingAddress` and then asking for it
 * again outside would run the four gates twice per booking. Splitting the entry point is the
 * same discipline ADR-0016 applies to the key: resolve once, hand it down.
 */
export async function placeAddressFor(
  eligibility: ActiveTravelEligibility,
  address: string,
  placeId?: string | null
): Promise<BookingPlacement> {
  // BY IDENTITY WHEN THE CUSTOMER PICKED ONE. Forward-geocoding a string Google itself produced
  // gets the same answer at best, so resolving the id instead is exact rather than equivalent -
  // and it is the difference between the slot that was checked and the booking that was made
  // being about one place by construction, rather than about two strings that happen to agree.
  const result = placeId?.trim()
    ? await resolvePlaceId(eligibility.tenantId, placeId)
    : await geocodeAddress(eligibility, address);
  return result.status === 'placed'
    ? { applies: true, outcome: 'placed', place: result.place }
    : { applies: true, outcome: result.status };
}

/**
 * An existing booking's placed address, refreshing it once and writing it back when the row
 * has no usable coordinates.
 *
 * TAKES THE ELIGIBILITY, NOT A TENANT ID. The caller reads a whole diary's worth of
 * neighbours for one travel check and resolved the gates once for that diary before it
 * started (ADR-0016), so re-resolving per neighbour would ask one question a dozen times.
 * Requiring the proof as an argument is what stops that shortcut from also becoming a hole:
 * there is no way to reach Google from here without having passed all four gates.
 *
 * A row with coordinates but no `place_id` counts as unresolved and is geocoded again. That
 * combination cannot come from this code, only from hand-edited or imported data. Re-placing
 * it is self-healing; treating it as complete would leave a row that can never be refreshed.
 *
 * Never throws: a booking whose position cannot be resolved is a booking with no position,
 * which every path here already handles, and a failed write-back only means the next read
 * pays for the lookup again.
 */
export async function placeExistingBooking(
  booking: Booking,
  eligibility: ActiveTravelEligibility
): Promise<BookingPlacement> {
  const stored = storedPlace(booking);
  if (stored) return { applies: true, outcome: 'placed', place: stored };

  // BY IDENTITY WHEN WE HAVE ONE. A booking whose coordinates aged out is not an unplaced
  // booking: we still know exactly which door it is, and the place id is the handle that
  // keeps the refresh identity-preserving. Re-reading the customer's typed string instead
  // would let the same words resolve somewhere else months later, silently moving a
  // confirmed appointment. Forward geocoding is the fallback for rows that never had a
  // place id at all, which is every row written before this feature existed.
  const result = booking.customerPlaceId
    ? await resolvePlaceId(eligibility.tenantId, booking.customerPlaceId)
    : booking.customerAddress?.trim()
      ? await geocodeAddress(eligibility, booking.customerAddress)
      : null;

  // A row carrying neither an identity nor an address is not a failed lookup — there was
  // nothing to look up. `applies: false` says that, where `unavailable` would blame Google.
  if (!result) return { applies: false };
  if (result.status !== 'placed') return { applies: true, outcome: result.status };
  await writeBackPlace(booking, result.place);
  return { applies: true, outcome: 'placed', place: result.place };
}

/**
 * The same refresh for a caller that only wants the position.
 *
 * One caller, the neighbour loader, and it has one question — where is this job — for which
 * all three ways a lookup can fail mean the same thing: `unresolved`. This exists so that
 * collapse is written down once, next to the placement it collapses, rather than at the call
 * site where a later reader would have to check it still matches the outcomes above.
 */
export async function ensureBookingPlace(
  booking: Booking,
  eligibility: ActiveTravelEligibility
): Promise<PlacedAddress | null> {
  const placement = await placeExistingBooking(booking, eligibility);
  return placement.applies && placement.outcome === 'placed' ? placement.place : null;
}

/**
 * Coordinates stop being ours after this long.
 *
 * ADR-0014: the Maps terms permit latitude and longitude for 30 consecutive calendar days
 * and no longer, while `place_id` may be kept for as long as the booking. That is a licence
 * boundary rather than a freshness heuristic, so it is enforced on every read here as well
 * as by the deletion job that removes the columns outright.
 *
 * Exported for that job, which has to delete strictly BEFORE this line rather than at it —
 * see `coordinate-retention.service.ts`. Two constants would be two answers to one licence
 * question, and the one that drifts would be the one nobody reads.
 */
export const COORDINATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The placed address already on the row, or null when there is nothing usable there.
 *
 * AGE IS A HARD CONDITION, not a preference. Coordinates older than the licence permits read
 * as absent, which sends the caller back through `geocodeAddress` and re-derives them. With
 * a 60-day default booking horizon that re-resolution is the NORMAL path for a far-future
 * appointment, not an edge case, so this branch is expected traffic. Deleting the expired
 * columns is a separate job and a separate ticket; refusing to USE them is what stops an
 * out-of-date position from deciding anything in the meantime.
 */
export function storedPlace(booking: Booking): PlacedAddress | null {
  // A row with coordinates but no stamp cannot be shown to be inside the window, and the
  // safe reading of an unknown age is that it has expired. A stamp in the FUTURE is refused
  // for the same reason and is the more dangerous of the two: clock skew or a hand-edited
  // row would otherwise keep one set of coordinates permanently fresh.
  const stampedAt = booking.customerCoordsAt ? new Date(booking.customerCoordsAt).getTime() : NaN;
  const age = Date.now() - stampedAt;
  if (!Number.isFinite(age) || age < 0 || age > COORDINATE_MAX_AGE_MS) return null;

  const candidate = {
    placeId: booking.customerPlaceId,
    lat: booking.customerLat,
    lng: booking.customerLng,
    precision: booking.geocodePrecision,
    formattedAddress: booking.customerAddressVerified ?? booking.customerAddress,
  } as PlacedAddress;
  // The same boundary Google's answers and the Redis cache cross. A row is no more trusted
  // than either of those: it can be hand-edited, imported, or written by an older version of
  // this code, and a placement that would fail the live checks must fail here too.
  return isUsablePlace(candidate) ? candidate : null;
}

/** Persist a lazily-resolved placement, and keep the in-memory row in step with it. */
async function writeBackPlace(booking: Booking, place: PlacedAddress): Promise<void> {
  const columns = bookingPlaceColumns({ applies: true, outcome: 'placed', place });
  const fields = {
    customerPlaceId: columns.placeId,
    customerLat: columns.lat,
    customerLng: columns.lng,
    customerCoordsAt: columns.coordsAt,
    customerAddressVerified: columns.addressVerified,
    geocodePrecision: columns.precision,
    locationSource: columns.locationSource,
  };
  try {
    await AppDataSource.getRepository(Booking).update(booking.id, fields);
    // Assigned from the same object that was persisted, so a caller still holding this row
    // reads exactly what the database now holds and does not re-resolve it moments later.
    Object.assign(booking, fields);
  } catch (error) {
    logger.warn('[Travel] could not write back a resolved place', { bookingId: booking.id, error });
  }
}

/** The columns a placement writes onto `chatbot_bookings`, in one place so two INSERTs cannot drift. */
export interface BookingPlaceColumns {
  placeId: string | null;
  lat: number | null;
  lng: number | null;
  coordsAt: Date | null;
  addressVerified: string | null;
  precision: GeocodePrecision | null;
  locationSource: LocationSource | null;
}

/**
 * A placement as row values.
 *
 * An UNTRUSTED result is still stored, in full. That is not an oversight to tidy up later:
 * the precision is what tells a later reader the position may only refuse and never clear,
 * and dropping the row's only record of what the gate had to work with would make an audit
 * of a wrong decision impossible. `isTrustedForTravel` is the single predicate that decides
 * what may be done with it.
 */
export function bookingPlaceColumns(placement: BookingPlacement): BookingPlaceColumns {
  if (!placement.applies || placement.outcome !== 'placed') {
    return {
      placeId: null,
      lat: null,
      lng: null,
      coordsAt: null,
      addressVerified: null,
      precision: null,
      locationSource: null,
    };
  }
  return {
    placeId: placement.place.placeId.trim() || null,
    lat: placement.place.lat,
    lng: placement.place.lng,
    // What the 30-day deletion job reads (ADR-0014). Stamped beside the coordinates rather
    // than derived from `created_at`, because a re-resolved booking has fresh coordinates on
    // an old row.
    coordsAt: new Date(),
    addressVerified: placement.place.formattedAddress || null,
    precision: placement.place.precision,
    // Everything is `geocoded` in v1. `pin` arrives with the customer sharing a location,
    // which WhatsApp and Telegram already deliver and the platform currently discards.
    locationSource: 'geocoded',
  };
}

/**
 * Did we end up with a position good enough to decide a drive?
 *
 * The one reading of trust, so nothing downstream can arrive at a second one. An
 * `approximate` result is a town centre: it collapses every address in a municipality onto
 * one dot, which can prove a drive impossible and can never prove one fine.
 */
export function placementIsTrusted(placement: BookingPlacement): boolean {
  return placement.applies && placement.outcome === 'placed' && isTrustedForTravel(placement.place.precision);
}

/**
 * Is this a position that may refuse a drive but never clear one?
 *
 * A town centre collapses every address in a municipality onto one dot (ADR-0014). The gate
 * still uses it — a dot eighty kilometres away proves a ten-minute drive impossible whichever
 * door it stands for — but nothing placed this coarsely may confirm an appointment.
 */
export function placementIsCoarse(placement: BookingPlacement): boolean {
  return placement.applies && placement.outcome === 'placed' && !isTrustedForTravel(placement.place.precision);
}

/**
 * Must the AUTO path refuse to confirm this?
 *
 * ONLY for an address we could not place AT ALL. That address has a recovery the customer can
 * act on — a postcode or a town — and the prompt already asks for one, retries once, and
 * captures a Request if it fails again.
 *
 * NOT for an address placed only to a town centre, and that changed when travel enforcement
 * landed. Refusing a coarse placement outright was right while there was no drive being
 * checked, because there was nothing else to do with it. Now there is: ADR-0015's rule is that
 * a coarse point falls through to the coordinate branch, where it can still refuse the
 * provably impossible and can never clear anything — so the customer keeps a list of times to
 * request instead of a dead end, and the appointment is still never silently confirmed.
 * `placementIsCoarse` is what carries that through to the gate.
 *
 * NOT when Google itself was unreachable or the Tenant's element cap was spent either. That is
 * not the customer's address being vague; the postcode recovery cannot help, so sending them
 * into it would be friction with no upside. The travel gate refuses to CLEAR anything without
 * coordinates, which is where an outage is actually handled.
 */
export function blocksAutoConfirm(placement: BookingPlacement): boolean {
  return placement.applies && placement.outcome === 'not_placeable';
}

/**
 * The Travel Check to stamp on a REQUEST row, or null to leave the column alone.
 *
 * `captured` means the job was held as a Request because there was nothing to reason over
 * (ADR-0015), which is true of an address we could not place AND of one we could not try to
 * place. The column cannot tell those two apart, and deliberately so: its four values
 * describe what the gate DID, and in both cases it did nothing. The cause is carried in the
 * logs, which is where a sustained run of either belongs anyway.
 *
 * A request whose address placed cleanly gets null. Nothing has checked a drive yet, and
 * `ok` is a claim about a gate that does not run until travel enforcement lands.
 */
export function requestTravelCheck(placement: BookingPlacement): 'captured' | null {
  if (!placement.applies) return null;
  return placementIsTrusted(placement) ? null : 'captured';
}
