/**
 * Customer-location bookings need a full appointment address, not a city name.
 *
 * The tool argument is a string. A presence check accepts "Antwerp" and then
 * availability plus Places chips treat that city as the job location.
 */
import { describe, it, expect } from 'vitest';
import {
  assertRequiredAddress,
  resolveCustomerEmail,
  assertRequiredPhone,
  hasStreetAndHouseNumber,
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
    'Rue de la Station 12, 4000 Liège',
    'Centraallaan 5, 2000 Antwerpen',
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
    'Grote Markt 1, Antwerpen',
    'the house behind the church',
  ])('rejects %s', (address) => {
    expect(isCompleteCustomerAddress(address)).toBe(false);
  });
});

describe('hasStreetAndHouseNumber', () => {
  it.each([
    'Kerkstraat 12, 9000 Gent',
    'Grote Markt 1, Antwerpen',
    'Kerkstraat 12, Antwerpen',
    'Passtraat 248 bus B, 9100 Sint-Niklaas',
    'Rue de la Station 12, 4000 Liège',
    'Centraallaan 5, 2000 Antwerpen',
  ])('accepts a door at %s', (address) => {
    expect(hasStreetAndHouseNumber(address)).toBe(true);
  });

  it.each([
    'Antwerp',
    'Antwerp, Belgium',
    '2000 Antwerpen',
    'Atomium, 1020 Brussel',
    'the house behind the church',
  ])('rejects %s', (address) => {
    expect(hasStreetAndHouseNumber(address)).toBe(false);
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

  it('treats a whitespace-only number as absent on a phone call', () => {
    expect(() => assertRequiredPhone(call, { customerPhone: '   ' })).toThrow(BookingError);
  });

  it('fills the number from a WhatsApp session on a phone call', () => {
    // resolvePhone is keyed on the SESSION, not the service, so a row that never had the
    // flag set must still get the channel fallback rather than a dead end.
    expect(() =>
      assertRequiredPhone(call, undefined, { channel: 'whatsapp', visitorId: '32470000000' }),
    ).not.toThrow();
  });

  it('does not invent a number from a Messenger PSID', () => {
    expect(() =>
      assertRequiredPhone(call, undefined, { channel: 'messenger', visitorId: '1234567890' }),
    ).toThrow(BookingError);
  });

  it('does not demand an address for that same phone-call row', () => {
    expect(() => assertRequiredAddress(call)).not.toThrow();
  });
});

describe('resolveCustomerEmail', () => {
  const invited: ServiceType = { customerEmailRequired: true } as ServiceType;
  const optional: ServiceType = { customerEmailRequired: false } as ServiceType;

  it('returns a valid address unchanged', () => {
    expect(resolveCustomerEmail(invited, 'ada@example.com')).toBe('ada@example.com');
  });

  it('returns the SANITIZED address, because the ICS ATTENDEE line and the mail `to` read it', () => {
    // sanitizeEmail accepts this after trimming, so presence-only validation would persist the
    // padded string and put a leading space inside mailto:.
    expect(resolveCustomerEmail(invited, '  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it('throws EMAIL_REQUIRED when the address is missing', () => {
    expect(() => resolveCustomerEmail(invited)).toThrow(BookingError);
    try {
      resolveCustomerEmail(invited);
    } catch (err) {
      expect(err).toMatchObject({ code: 'EMAIL_REQUIRED' });
      expect((err as BookingError).message).toMatch(/calendar invite/i);
      expect((err as BookingError).message).toMatch(/attendeeEmail/);
      expect((err as BookingError).message).toMatch(/do not capture a request or a lead/i);
    }
  });

  it('treats a whitespace-only address as absent', () => {
    expect(() => resolveCustomerEmail(invited, '   ')).toThrow(BookingError);
  });

  it('throws EMAIL_REQUIRED for a malformed address, so the invite cannot go nowhere', () => {
    expect(() => resolveCustomerEmail(invited, 'not-an-email')).toThrow(BookingError);
    try {
      resolveCustomerEmail(invited, 'not-an-email');
    } catch (err) {
      expect(err).toMatchObject({ code: 'EMAIL_REQUIRED' });
      expect((err as BookingError).message).toMatch(/not valid/i);
    }
  });

  it('refuses an address longer than the attendee_email column, instead of overflowing the INSERT', () => {
    const tooLong = `${'a'.repeat(310)}@example.com`;
    expect(tooLong.length).toBeGreaterThan(320);
    expect(() => resolveCustomerEmail(invited, tooLong)).toThrow(BookingError);
    expect(resolveCustomerEmail(optional, tooLong)).toBeNull();
  });

  it('returns null when the owner unticked the flag', () => {
    expect(resolveCustomerEmail(optional)).toBeNull();
  });

  it('returns null rather than junk for an unusable address once the flag is off', () => {
    // Nothing can be mailed to it, and booking-email already treats null as "no invite sent".
    expect(resolveCustomerEmail(optional, 'not-an-email')).toBeNull();
  });

  it('still requires the address when the property is absent, because the flag is default-on', () => {
    // An existing row read before the column existed, or a partial fixture: undefined must
    // mean required, or the migration default silently stops applying.
    expect(() => resolveCustomerEmail({} as ServiceType)).toThrow(BookingError);
  });
});
