/**
 * WHO TRAVELS - one answer, from locationType, with a legacy fallback.
 *
 * `business_location`, `customer_location` and `phone` are stored authority. The owner
 * picks them in the service editor. Contact flags are then forced to match, so travel
 * gates, ADDRESS_REQUIRED and PHONE_REQUIRED keep working without a second source of truth.
 *
 * `in_person` is a review leftover: it still means the premises unless the travel flag
 * is on. The dropdown no longer offers it. `unset` is still "nobody was asked" (#71).
 *
 * For google_meet / custom, a leftover travel flag still wins, because service-area
 * gating already refuses those rows on the flag alone. New writes do not create that pair.
 * `phone` does not honour a leftover travel flag: a phone call is not a travel job.
 *
 * The resolver stays read-only. `remote` still collapses video / phone / custom, so nothing
 * may write a locationType back through this.
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
 * The fields the answer is derived from.
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
   * address, and the customer chooses at booking time. A fact, not a stored mode -
   * the resolver still projects who travels. Only meaningful for a physical Service
   * in a Both business; ignored when the Service is remote.
   */
  customerChoosesLocation?: boolean | null;
}

/** Premises jobs: the venue is the location. Includes review leftovers. */
export function isPremisesLocationType(locationType: string | null | undefined): boolean {
  return locationType === 'business_location' || locationType === 'in_person' || locationType === 'unset';
}

/**
 * Force contact flags to match an explicit location type.
 *
 * customer_location cannot exist without an address. business_location cannot require one.
 * A phone call requires a phone number and cannot require an address.
 * Other types are left alone, including review leftovers.
 */
export function locationTypeSideEffects(locationType: string | undefined): {
  customerAddressRequired?: boolean;
  customerChoosesLocation?: boolean;
  customerLocationRequired?: boolean;
} {
  if (locationType === 'customer_location') {
    return { customerAddressRequired: true, customerChoosesLocation: false };
  }
  if (locationType === 'business_location') {
    return { customerAddressRequired: false };
  }
  if (locationType === 'phone') {
    return {
      customerAddressRequired: false,
      customerChoosesLocation: false,
      customerLocationRequired: true,
    };
  }
  return {};
}

/**
 * Who travels for this Service.
 *
 * Explicit stored types win. `business_location`, `customer_location` and `phone` do not
 * read the address flag, so a stale checkbox cannot move the appointment. Legacy values
 * still honour the flag, because that is how travel jobs were stored before the split.
 */
export function resolveServiceLocationMode(service: ServiceLocationFacts): ServiceLocationMode {
  if (service.locationType === 'customer_location') return 'customer_location';
  if (service.locationType === 'business_location') {
    if (service.customerChoosesLocation) return 'customer_choice';
    return 'business_location';
  }
  if (service.locationType === 'phone') return 'remote';
  // Legacy / review: the travel flag is still the stronger statement.
  if (service.customerAddressRequired) return 'customer_location';
  if (service.locationType === 'in_person' || service.locationType === 'unset') {
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
 * Does THIS booking need the customer's phone number?
 *
 * A phone call always does. Other types honour the stored flag, which is how an
 * on-site job asks for a callback number.
 */
export function serviceNeedsCustomerPhone(service: {
  locationType?: string | null;
  customerLocationRequired?: boolean | null;
}): boolean {
  if (service.locationType === 'phone') return true;
  return !!service.customerLocationRequired;
}

/**
 * Tokens the SERVICES catalog line shows the model, in order.
 *
 * The model must receive the location type explicitly and must not infer it from
 * "needs address" or from the service name.
 */
export function serviceCatalogLocationFlags(service: ServiceLocationFacts): string[] {
  const flags: string[] = [];
  if (service.locationType === 'google_meet') flags.push('video call');
  else if (service.locationType === 'phone') flags.push('phone call');
  const mode = resolveServiceLocationMode(service);
  if (mode === 'customer_choice') flags.push('customer chooses location');
  else if (mode === 'customer_location') flags.push('at customer location');
  else if (mode === 'business_location') flags.push('at business location');
  if (mode === 'customer_location') flags.push('needs address');
  return flags;
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
