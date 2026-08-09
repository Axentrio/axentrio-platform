/**
 * #79 LP1 - one answer to "who travels", and it must not disagree with the invite.
 *
 * The mode is a projection over `locationType` and `customerAddressRequired`, which already
 * contradict each other in the data. Two things can go wrong: the projection can be wrong, and
 * it can be right while disagreeing with `resolveEventLocation`, which answers the same question
 * for a different purpose. The second is worse, because nothing fails - a Service would simply
 * be planned as one kind and invited as another.
 *
 * So the last block below is the real guard: for every combination of the two fields, the mode
 * and the invite have to tell the same story. That is a property over the whole input space
 * rather than a list of cases somebody thought of.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveServiceLocationMode,
  resolveWorkLocation,
  isPhysical,
  type ServiceLocationFacts,
} from '../../booking/service-location';
import { resolveEventLocation } from '../../booking/booking-providers/event-location';
import type { LocationType } from '../../database/entities/ServiceType';

const ALL_LOCATION_TYPES: LocationType[] = ['google_meet', 'phone', 'in_person', 'custom', 'unset'];
const venue = { street: 'Grote Markt 1', postalCode: '9300', city: 'Aalst', country: null };

describe('who travels', () => {
  it('the customer address wins outright, whatever the modality says', () => {
    // The stronger statement, and the ordering `event-location.ts` already applies. Service-area
    // gating refuses a booking on this flag ALONE without ever reading `locationType`, so a
    // Service that is a travel job for that purpose cannot be "no location" for this one.
    for (const locationType of ALL_LOCATION_TYPES) {
      expect(resolveServiceLocationMode({ locationType, customerAddressRequired: true })).toBe(
        'customer_location'
      );
    }
  });

  it('in_person without a customer address is the premises', () => {
    expect(resolveServiceLocationMode({ locationType: 'in_person' })).toBe('business_location');
  });

  it('unset is the PREMISES, not remote (#71)', () => {
    // The trap this resolver would otherwise walk into. `unset` means nobody was ever asked -
    // the column shipped NOT NULL DEFAULT 'custom' with no backfill - and `resolveEventLocation`
    // treats those rows as the premises. Folding them into `remote` here would make one row
    // remote for planning and physical for its own invite.
    expect(resolveServiceLocationMode({ locationType: 'unset' })).toBe('business_location');
  });

  it.each<LocationType>(['google_meet', 'phone', 'custom'])('%s is remote', (locationType) => {
    expect(resolveServiceLocationMode({ locationType })).toBe('remote');
  });

  it('treats a null customer-address flag as false, not as unknown', () => {
    expect(resolveServiceLocationMode({ locationType: 'phone', customerAddressRequired: null })).toBe('remote');
  });
});

describe('what kind of business this is', () => {
  const svc = (locationType: LocationType, customerAddressRequired = false): ServiceLocationFacts => ({
    locationType,
    customerAddressRequired,
  });

  it('no physical service means there is no geography to plan against', () => {
    expect(resolveWorkLocation([svc('google_meet'), svc('phone')])).toBe('no_location');
  });

  it('an empty catalog answers the same, because the question is about geography', () => {
    expect(resolveWorkLocation([])).toBe('no_location');
  });

  it('every physical service at the premises is one location', () => {
    expect(resolveWorkLocation([svc('in_person'), svc('phone')])).toBe('at_one_location');
  });

  it('every physical service at the customer is on the road', () => {
    expect(resolveWorkLocation([svc('in_person', true), svc('google_meet')])).toBe('on_the_road');
  });

  it('one of each is both, which is the case the raw spec collapsed', () => {
    expect(resolveWorkLocation([svc('in_person'), svc('in_person', true)])).toBe('both');
  });

  it('a legacy unset service counts as physical, so it is not silently ignored', () => {
    // The whole point of #71's `unset`: these rows are the ones an owner never touched, so they
    // are exactly the ones a projection would quietly drop.
    expect(resolveWorkLocation([svc('unset')])).toBe('at_one_location');
  });

  it('isPhysical is the same line the projection draws', () => {
    expect(isPhysical('remote')).toBe(false);
    expect(isPhysical('business_location')).toBe(true);
    expect(isPhysical('customer_location')).toBe(true);
  });
});

describe('the mode and the invite cannot disagree', () => {
  /**
   * Over the WHOLE input space, not a chosen sample.
   *
   * Two functions answering "who travels" for different purposes is a drift waiting to happen,
   * and the failure is silent: a Service planned as remote whose invite carries the premises
   * address, or the reverse. Stating it as a property means a value added to `LocationType`
   * later is covered here the moment it is added to the union.
   */
  const combinations = ALL_LOCATION_TYPES.flatMap((locationType) =>
    [true, false].map((customerAddressRequired) => ({ locationType, customerAddressRequired }))
  );

  it.each(combinations)('$locationType / travels=$customerAddressRequired', (facts) => {
    const mode = resolveServiceLocationMode(facts);
    const invite = resolveEventLocation({
      ...facts,
      customerAddress: 'Kerkstraat 12, 9000 Gent',
      venue,
    });

    if (mode === 'customer_location') {
      expect(invite).toBe('Kerkstraat 12, 9000 Gent');
    } else if (mode === 'business_location') {
      expect(invite).toBe('Grote Markt 1, 9300 Aalst');
    } else {
      // Remote: the invite deliberately carries no place. A meeting URL, when one exists, wins
      // ahead of all of this and is not a location claim.
      expect(invite).toBeUndefined();
    }
  });
});
