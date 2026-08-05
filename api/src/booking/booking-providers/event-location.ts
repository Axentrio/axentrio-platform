/**
 * What goes in the calendar event's LOCATION — and, just as often, what does not.
 *
 * RFC 5545 §3.8.1.7 defines LOCATION as "the intended venue for the activity". Every site
 * in this codebase used to send the literal string `"In person"` for any `in_person`
 * service, which is a MODALITY, not a venue: it tells the customer standing in the street
 * nothing at all, and it occupies the one field their calendar app would otherwise use to
 * offer directions.
 *
 * Four cases, and the fourth is the one that matters most:
 *
 *   1. A meeting URL exists          → the URL. Unchanged, and it wins outright: a service
 *                                      configured for premises that nonetheless produced a
 *                                      Meet link is an online booking in practice.
 *   2. In person, owner travels      → the CUSTOMER's address. Their own address in their
 *                                      own invite discloses nothing new to them, and it is
 *                                      the genuinely useful value on the owner's copy —
 *                                      which until now only carried it as a body line.
 *   3. In person, at the premises    → the venue address, IF the owner has entered one.
 *   4. Anything else                 → OMIT. Not `''`, not a placeholder.
 *
 * Case 4 is conformant, not degraded: RFC 5546 lists LOCATION as `0 or 1` for a VEVENT
 * REQUEST. An absent property means "no venue stated"; an empty one means "the venue is
 * named empty string", which is worse than saying nothing.
 *
 * Pure and dependency-free on purpose — importing this from internal.provider must not
 * drag the entity graph (and a live DB connection) into a unit test, which is the same
 * reason `service-timing.ts` exists separately.
 */
import type { VenueAddress } from '../../contracts/venue-address';
import { formatVenueLine } from '../../contracts/venue-address';

/** Mirrors `ServiceType['locationType']` without importing the entity. */
export type EventLocationType = 'google_meet' | 'phone' | 'in_person' | 'custom';

export interface EventLocationInput {
  locationType: EventLocationType;
  /** The service sends the owner to the customer, so the customer's address is the venue. */
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
 * options object — an explicit `null` would serialise as a present-but-empty property.
 */
export function resolveEventLocation(input: EventLocationInput): string | undefined {
  const meetUrl = input.meetUrl?.trim();
  if (meetUrl) return meetUrl;

  if (input.locationType !== 'in_person') return undefined;

  if (input.customerAddressRequired) {
    const customer = input.customerAddress?.replace(/\s+/g, ' ').trim();
    return customer ? customer : undefined;
  }

  return formatVenueLine(input.venue) ?? undefined;
}
