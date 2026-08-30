/**
 * What goes in the calendar event's LOCATION - and, just as often, what does not.
 *
 * RFC 5545 §3.8.1.7 defines LOCATION as "the intended venue for the activity". Every site
 * in this codebase used to send the literal string `"In person"` for any `in_person`
 * service, which is a MODALITY, not a venue: it tells the customer standing in the street
 * nothing at all, and it occupies the one field their calendar app would otherwise use to
 * offer directions.
 *
 * Cases:
 *
 *   1. A meeting URL exists             → the URL. Unchanged, and it wins outright.
 *   2. `customer_location`              → the CUSTOMER's address. Never the business address.
 *   3. `business_location`              → the venue address, IF the owner has entered one.
 *   4. Legacy travel flag               → customer address, for leftover custom/unset/in_person.
 *   5. Legacy `in_person` / `unset`     → the venue, same as today until the owner reviews.
 *   6. Phone, video, something else     → OMIT. Not `''`, not a placeholder, not the venue.
 *
 * Case 6 is conformant, not degraded: RFC 5546 lists LOCATION as `0 or 1` for a VEVENT
 * REQUEST. An absent property means "no venue stated"; an empty one means "the venue is
 * named empty string", which is worse than saying nothing.
 *
 * Pure and dependency-free on purpose - importing this from internal.provider must not
 * drag the entity graph (and a live DB connection) into a unit test, which is the same
 * reason `service-timing.ts` exists separately.
 */
import type { VenueAddress } from '../../contracts/venue-address';
import { formatVenueLine } from '../../contracts/venue-address';
import {
  serviceNeedsCustomerAddress,
  type ServiceLocationFacts,
} from '../service-location';

/**
 * Mirrors `ServiceType['locationType']` without importing the entity.
 *
 * Kept in sync by the compiler rather than by memory: every call site passes a `LocationType`
 * straight in, so a value added there and forgotten here fails to typecheck at each of them.
 * That is how `unset` (#71) was caught, and it is the reason this duplication is tolerable.
 */
export type EventLocationType =
  | 'google_meet'
  | 'phone'
  | 'business_location'
  | 'customer_location'
  | 'in_person'
  | 'custom'
  | 'unset';

export interface EventLocationInput {
  locationType: EventLocationType;
  /** This booking is at the customer's address, so that address is the venue. */
  customerAddressRequired: boolean;
  /** A Meet/Teams URL, when one was generated. */
  meetUrl?: string | null;
  /** Captured on the booking for travel jobs. */
  customerAddress?: string | null;
  /** The business's own premises, null until an owner enters one. */
  venue?: Partial<VenueAddress> | null;
}

/**
 * Resolve the LOCATION value, or `undefined` when the property should be omitted.
 *
 * Returns `undefined` rather than `null` because that is what every caller spreads into an
 * options object - an explicit `null` would serialise as a present-but-empty property.
 */
export function resolveEventLocation(input: EventLocationInput): string | undefined {
  const meetUrl = input.meetUrl?.trim();
  if (meetUrl) return meetUrl;

  const customerLine = () => {
    const customer = input.customerAddress?.replace(/\s+/g, ' ').trim();
    return customer ? customer : undefined;
  };

  // Explicit stored types win. A stale address flag must not send a business-location
  // booking to the customer, a customer-location booking to the shop, or a phone call
  // to anyone's street address.
  if (input.locationType === 'customer_location') return customerLine();
  if (input.locationType === 'business_location') return formatVenueLine(input.venue) ?? undefined;
  if (input.locationType === 'phone') return undefined;

  // Legacy / review leftovers: the travel flag is still the stronger statement, because
  // service-area gating already refuses those rows on the flag alone.
  if (input.customerAddressRequired) return customerLine();

  // `in_person` (review leftover) and `unset` (#71) still mean the premises until the
  // owner picks. `custom` stays empty on purpose.
  if (input.locationType !== 'in_person' && input.locationType !== 'unset') return undefined;
  return formatVenueLine(input.venue) ?? undefined;
}

/**
 * Calendar LOCATION for a live booking: uses this booking's address need, not the
 * catalog flag alone, so a customer_choice pick at the customer's address cannot
 * put the shop on the invite.
 */
export function resolveBookingEventLocation(
  service: ServiceLocationFacts,
  input: {
    meetUrl?: string | null;
    customerAddress?: string | null;
    venue?: Partial<VenueAddress> | null;
    locationChoice?: string | null;
  },
): string | undefined {
  return resolveEventLocation({
    locationType: service.locationType,
    customerAddressRequired: serviceNeedsCustomerAddress(service, {
      locationChoice: input.locationChoice,
      customerAddress: input.customerAddress,
    }),
    meetUrl: input.meetUrl,
    customerAddress: input.customerAddress,
    venue: input.venue,
  });
}
