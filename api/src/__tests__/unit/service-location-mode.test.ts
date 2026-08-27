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
  serviceNeedsCustomerAddress,
  locationTypeSideEffects,
  type ServiceLocationFacts,
} from '../../booking/service-location';
import { resolveEventLocation } from '../../booking/booking-providers/event-location';
import type { LocationType } from '../../database/entities/ServiceType';

const ALL_LOCATION_TYPES: LocationType[] = [
  'google_meet',
  'phone',
  'in_person',
  'business_location',
  'customer_location',
  'custom',
  'unset',
];
const venue = { street: 'Grote Markt 1', postalCode: '9300', city: 'Aalst', country: null };

describe('who travels', () => {
  it('the customer address wins on leftover types, whatever the modality says', () => {
    // Service-area gating refuses a booking on this flag ALONE for google_meet / phone / custom /
    // in_person / unset, so those rows cannot be "no location" here either.
    for (const locationType of ['google_meet', 'phone', 'in_person', 'custom', 'unset'] as LocationType[]) {
      expect(resolveServiceLocationMode({ locationType, customerAddressRequired: true })).toBe(
        'customer_location'
      );
    }
  });

  it('explicit customer_location does not need the travel flag', () => {
    expect(resolveServiceLocationMode({ locationType: 'customer_location' })).toBe('customer_location');
  });

  it('explicit business_location ignores a stale travel flag', () => {
    expect(
      resolveServiceLocationMode({ locationType: 'business_location', customerAddressRequired: true }),
    ).toBe('business_location');
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

  it('customerChoosesLocation is its own mode — the booking customer picks business or theirs', () => {
    expect(
      resolveServiceLocationMode({
        locationType: 'in_person',
        customerAddressRequired: false,
        customerChoosesLocation: true,
      }),
    ).toBe('customer_choice');
  });

  it('customerChoosesLocation on business_location is still a per-booking pick', () => {
    expect(
      resolveServiceLocationMode({
        locationType: 'business_location',
        customerChoosesLocation: true,
      }),
    ).toBe('customer_choice');
  });
});

describe('what kind of business this is', () => {
  const svc = (
    locationType: LocationType,
    customerAddressRequired = false,
    customerChoosesLocation = false,
  ): ServiceLocationFacts => ({
    locationType,
    customerAddressRequired,
    customerChoosesLocation,
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
    expect(isPhysical('customer_choice')).toBe(true);
  });

  it('a choose-at-booking Service makes the catalog Both on its own', () => {
    expect(resolveWorkLocation([svc('in_person', false, true)])).toBe('both');
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

describe('does THIS booking need the customer address', () => {
  const choose: ServiceLocationFacts = {
    locationType: 'in_person',
    customerAddressRequired: false,
    customerChoosesLocation: true,
  };

  it('always, for a travel Service', () => {
    expect(serviceNeedsCustomerAddress({ locationType: 'in_person', customerAddressRequired: true })).toBe(true);
  });

  it('never, for a premises-only Service', () => {
    expect(serviceNeedsCustomerAddress({ locationType: 'in_person' })).toBe(false);
  });

  it('when the customer picks their own location', () => {
    expect(serviceNeedsCustomerAddress(choose, { locationChoice: 'customer' })).toBe(true);
  });

  it('not when the customer picks the business', () => {
    expect(serviceNeedsCustomerAddress(choose, { locationChoice: 'business' })).toBe(false);
  });

  it('always, for explicit customer_location, even without the flag', () => {
    expect(serviceNeedsCustomerAddress({ locationType: 'customer_location' })).toBe(true);
  });

  it('never, for explicit business_location', () => {
    expect(serviceNeedsCustomerAddress({ locationType: 'business_location' })).toBe(false);
  });
});

describe('locationTypeSideEffects', () => {
  it('locks customer_location onto a required address', () => {
    expect(locationTypeSideEffects('customer_location')).toEqual({
      customerAddressRequired: true,
      customerChoosesLocation: false,
    });
  });

  it('clears the address flag for business_location', () => {
    expect(locationTypeSideEffects('business_location')).toEqual({ customerAddressRequired: false });
  });

  it('leaves leftover types alone', () => {
    expect(locationTypeSideEffects('in_person')).toEqual({});
    expect(locationTypeSideEffects('google_meet')).toEqual({});
  });
});
