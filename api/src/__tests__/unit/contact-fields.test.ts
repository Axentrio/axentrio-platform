/**
 * Customer-location bookings need a full appointment address, not a city name.
 *
 * The tool argument is a string. A presence check accepts "Antwerp" and then
 * availability plus Places chips treat that city as the job location.
 */
import { describe, it, expect } from 'vitest';
import {
  assertRequiredAddress,
  assertRequiredPhone,
  isCompleteCustomerAddress,
  resolveContactFields,
} from '../../booking/booking-providers/contact';
import { BookingError } from '../../booking/booking-providers/types';
import type { ServiceType } from '../../database/entities/ServiceType';

const mobile: ServiceType = {
  locationType: 'customer_location',
  customerAddressRequired: true,
} as ServiceType;

const desk: ServiceType = {
  locationType: 'business_location',
  customerAddressRequired: false,
} as ServiceType;

const choice: ServiceType = {
  locationType: 'in_person',
  customerAddressRequired: false,
  customerChoosesLocation: true,
} as ServiceType;

describe('isCompleteCustomerAddress', () => {
  it.each([
    'Kerkstraat 12, 9000 Gent',
    'Kerkstraat 12, 9000 Gent, Belgium',
    'Passtraat 248 bus B, 9100 Sint-Niklaas',
    'Rue des Guillemins 12, 4000 Liège',
    'Meir 78, 2000 Antwerpen',
    'Grote Baan 220, 9310 Herdersem',
    'Turnhoutsebaan 100, 2140 Antwerpen',
  ])('accepts %s', (address) => {
    expect(isCompleteCustomerAddress(address)).toBe(true);
  });

  it.each([
    undefined,
    null,
    '',
    '   ',
    'Antwerp',
    'Antwerp, Belgium',
    'Antwerpen, Antwerp, Belgium',
    'Antwerpen-Centraal, Koningin Astridplein, Antwerp, Belgium',
    'Gent',
    '2000 Antwerpen',
    'Kerkstraat 12',
    'Kerkstraat 12, Antwerpen',
    'the house behind the church',
  ])('rejects %s', (address) => {
    expect(isCompleteCustomerAddress(address)).toBe(false);
  });
});

describe('assertRequiredAddress', () => {
  it('does not demand an address for a premises service', () => {
    expect(() => assertRequiredAddress(desk)).not.toThrow();
  });

  it('throws ADDRESS_REQUIRED when a customer-location service has no address', () => {
    expect(() => assertRequiredAddress(mobile)).toThrow(BookingError);
    try {
      assertRequiredAddress(mobile);
    } catch (err) {
      expect(err).toMatchObject({ code: 'ADDRESS_REQUIRED' });
      expect((err as BookingError).message).toMatch(/street/i);
      expect((err as BookingError).message).toMatch(/house number/i);
      expect((err as BookingError).message).toMatch(/postal code/i);
      expect((err as BookingError).message).toMatch(/city/i);
      expect((err as BookingError).message).toMatch(/map search results/i);
    }
  });

  it('throws ADDRESS_REQUIRED for a city-only string', () => {
    expect(() =>
      assertRequiredAddress(mobile, { customerAddress: 'Antwerp' }),
    ).toThrow(BookingError);
    try {
      assertRequiredAddress(mobile, { customerAddress: 'Antwerpen, Antwerp, Belgium' });
    } catch (err) {
      expect(err).toMatchObject({ code: 'ADDRESS_REQUIRED' });
    }
  });

  it('accepts a full Belgian appointment address', () => {
    expect(() =>
      assertRequiredAddress(mobile, { customerAddress: 'Kerkstraat 12, 9000 Gent' }),
    ).not.toThrow();
  });

  it('does not demand an address when the customer picked the business', () => {
    expect(() =>
      assertRequiredAddress(choice, { locationChoice: 'business' }),
    ).not.toThrow();
  });

  it('demands a full address when the customer picked their own location', () => {
    expect(() =>
      assertRequiredAddress(choice, { locationChoice: 'customer', customerAddress: 'Antwerp' }),
    ).toThrow(BookingError);
    expect(() =>
      assertRequiredAddress(choice, {
        locationChoice: 'customer',
        customerAddress: 'Kerkstraat 12, 9000 Gent',
      }),
    ).not.toThrow();
  });
});

describe('resolveContactFields', () => {
  it('persists a trimmed complete address', () => {
    expect(
      resolveContactFields(mobile, { customerAddress: '  Kerkstraat 12, 9000 Gent  ' }),
    ).toEqual({ address: 'Kerkstraat 12, 9000 Gent', phone: null });
  });

  it('rejects a city name on the write path', () => {
    expect(() => resolveContactFields(mobile, { customerAddress: 'Antwerp' })).toThrow(
      BookingError,
    );
  });
});

describe('assertRequiredPhone', () => {
  const call: ServiceType = {
    locationType: 'phone',
    customerLocationRequired: false,
    customerAddressRequired: true,
  } as ServiceType;

  it('throws PHONE_REQUIRED for a phone call that never had the phone flag set', () => {
    expect(() => assertRequiredPhone(call)).toThrow(BookingError);
    expect(() => assertRequiredPhone(call)).toThrow(/customerPhone/);
  });

  it('accepts a phone call once the number is given', () => {
    expect(() => assertRequiredPhone(call, { customerPhone: '+32470000000' })).not.toThrow();
  });

  it('does not demand an address for that same phone-call row', () => {
    expect(() => assertRequiredAddress(call)).not.toThrow();
  });
});
