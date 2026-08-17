/**
 * WHO TRAVELS - one answer, derived, never stored (#79, LP1).
 *
 * A Service's location is spread across two fields that already contradict each other.
 * `ServiceType.locationType` says video / phone / in-person / custom / unset, and
 * `ServiceType.customerAddressRequired` says the owner goes to the Booking Customer. Nothing can
 * be ranked geographically until one thing answers "who travels", and today every caller that
 * needs to know re-derives it from those two fields with its own precedence rule.
 *
 * A RESOLVER, NOT A STORED COLUMN, and the distinction is the whole of this phase. A stored enum
 * would be new authority: a migration, a backfill, compatibility reads and a deprecation path for
 * the two columns that hold the facts today. A resolver is a canonical projection over what
 * already exists, computed in one place. Stored authority can come later, behind an explicit
 * migration plan, and never as a side effect of this.
 *
 * READ-ONLY, and this is not a stylistic preference. `remote` collapses `google_meet`, `phone`
 * and `custom`, which are three different behaviours and one of them mints a meeting link.
 * "Remote" does not say which to persist, so a round trip through this concept would silently
 * lose what the owner set. The remote MODALITY keeps its own control, edited as it is today. A
 * screen may show the two together; nothing may write back through this.
 */
import type { LocationType } from '../database/entities/ServiceType';

/** Who travels, for one Service. */
export type ServiceLocationMode =
  | 'remote'
  | 'business_location'
  | 'customer_location'
  /** Booking Customer picks business or their own address at booking time (#149). */
  | 'customer_choice';

/**
 * The two fields the answer is derived from.
 *
 * Structural rather than `ServiceType`, so this stays usable from a unit test, a projection and
 * the portal contract without dragging the entity graph and a live database connection behind
 * it - the same reason `event-location.ts` mirrors its own input type.
 */
export interface ServiceLocationFacts {
  locationType: LocationType;
  customerAddressRequired?: boolean | null;
  /**
   * Owner-set: this Service can happen at the premises OR at the Booking Customer's
   * address, and the customer chooses at booking time. A fact, not a stored mode —
   * the resolver still projects who travels. Only meaningful for a physical Service
   * in a Both business; ignored when the Service is remote.
   */
  customerChoosesLocation?: boolean | null;
}

/**
 * Who travels for this Service.
 *
 * THE ORDER IS THE CONTRACT, and it is the order `event-location.ts` already applies for invite
 * purposes. `customerAddressRequired` is the stronger statement and wins outright: service-area
 * gating geocodes the Booking Customer's address and REFUSES the booking on that flag alone,
 * without ever reading `locationType`. A Service that is a travel job for that purpose cannot
 * also be "no location at all" for this one. Reading them the other way round is exactly the bug
 * that dropped the customer's own address from invites for every Service still sitting on the
 * `custom` default the column shipped with.
 *
 * `unset` resolves to the BUSINESS LOCATION, not to remote, and the reason is #71. It means
 * nobody was ever asked - the column shipped `NOT NULL DEFAULT 'custom'` with no backfill, so
 * every Service created before the dropdown existed says `custom` without anyone having chosen.
 * `resolveEventLocation` treats those rows as the premises and puts the venue on the invite;
 * folding them into `remote` here would make the same row remote for planning and physical for
 * its invite, which is worse than either answer alone.
 */
export function resolveServiceLocationMode(service: ServiceLocationFacts): ServiceLocationMode {
  if (service.customerAddressRequired) return 'customer_location';
  if (service.locationType === 'in_person' || service.locationType === 'unset') {
    // A Both-business Service the owner marked "customer can choose": the Booking
    // Customer picks business or theirs. Must not collapse into business_location
    // (no address asked) or customer_location (always travel).
    if (service.customerChoosesLocation) return 'customer_choice';
    return 'business_location';
  }
  return 'remote';
}

/** A Service that happens somewhere physical, which is what geography can act on. */
export function isPhysical(mode: ServiceLocationMode): boolean {
  return mode !== 'remote';
}

/**
 * Does THIS booking need the customer's address?
 *
 * For a choose-at-booking Service the answer is the customer's pick, not the
 * catalog flag: business location needs no address and no travel; their own
 * location does. A missing/unusable choice fails safe to "no address" so we
 * never invent a travel job.
 */
export function serviceNeedsCustomerAddress(
  service: ServiceLocationFacts,
  extras?: { locationChoice?: string | null; customerAddress?: string | null },
): boolean {
  const mode = resolveServiceLocationMode(service);
  if (mode === 'customer_location') return true;
  if (mode !== 'customer_choice') return false;
  const choice = extras?.locationChoice;
  if (choice === 'customer') return true;
  if (choice === 'business') return false;
  // Unstated choice: an address already given is a strong signal they picked theirs;
  // otherwise fail safe to the business (no invented travel).
  return !!extras?.customerAddress?.trim();
}

/**
 * What kind of business this is, summarised from its Services.
 *
 * A PROJECTION, never a stored scheduling authority. A `work_location` column deciding behaviour
 * independently of `ServiceType` would be a second source of truth for a fact the Services
 * already state, and it would drift the first time an owner edited a Service without the column
 * noticing.
 */
export type WorkLocation = 'no_location' | 'at_one_location' | 'on_the_road' | 'both';

/**
 * Summarise a catalog.
 *
 * `no_location` covers both "no physical Service" and "no Service at all", which are the same
 * answer to the question this asks: there is no geography to plan against. A caller that needs
 * to tell an empty catalog from a fully-remote one is asking a different question and should ask
 * it of the catalog.
 */
export function resolveWorkLocation(services: ServiceLocationFacts[]): WorkLocation {
  let atBusiness = false;
  let atCustomer = false;
  for (const service of services) {
    const mode = resolveServiceLocationMode(service);
    if (mode === 'business_location') atBusiness = true;
    if (mode === 'customer_location') atCustomer = true;
    // A choose-at-booking Service is BOTH places until the customer picks.
    if (mode === 'customer_choice') {
      atBusiness = true;
      atCustomer = true;
    }
  }
  if (atBusiness && atCustomer) return 'both';
  if (atCustomer) return 'on_the_road';
  if (atBusiness) return 'at_one_location';
  return 'no_location';
}
