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
export type ServiceLocationMode = 'remote' | 'business_location' | 'customer_location';

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
    return 'business_location';
  }
  return 'remote';
}

/** A Service that happens somewhere physical, which is what geography can act on. */
export function isPhysical(mode: ServiceLocationMode): boolean {
  return mode !== 'remote';
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
  }
  if (atBusiness && atCustomer) return 'both';
  if (atCustomer) return 'on_the_road';
  if (atBusiness) return 'at_one_location';
  return 'no_location';
}
