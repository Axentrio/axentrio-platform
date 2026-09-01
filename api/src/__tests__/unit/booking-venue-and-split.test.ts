/**
 * The venue address, the LOCATION it resolves to, and the owner/customer mail split.
 *
 * `sendBookingEmail` used to put the owner on the customer's `To:` line. Changing that to
 * two separate messages broke NO test in the suite, because nothing had ever asserted who
 * receives what — the same shape of gap that let seven mutations survive the capacity
 * gates. These tests exist so the next change to recipients cannot pass silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveEventLocation } from '../../booking/booking-providers/event-location';
import { buildCustomerEventDescription } from '../../booking/booking-providers/booking-content';
import {
  organizerAddressForTenant,
  senderFor,
  isOnVerifiedDomain,
} from '../../booking/booking-providers/organizer-address';
import {
  normalizeVenue,
  formatVenueLine,
  hasVenue,
  EMPTY_VENUE,
  VENUE_FIELD_MAX,
} from '../../contracts/venue-address';

const sendDurable = vi.fn();
vi.mock('../../services/email-delivery.service', () => ({
  emailDeliveryService: {
    sendDurable: (...a: unknown[]) => sendDurable(...a),
  },
}));
vi.mock('../../automations/email.service', () => ({
  EmailService: class {
    send() {
      return Promise.resolve({ success: true });
    }
  },
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sendBookingEmail } from '../../booking/booking-providers/booking-email';

// --------------------------------------------------------------------------------------

describe('venue address — normalise and flatten', () => {
  it('is empty until someone fills it in', () => {
    expect(hasVenue(EMPTY_VENUE)).toBe(false);
    expect(hasVenue(null)).toBe(false);
    expect(formatVenueLine(null)).toBeNull();
  });

  it('flattens to the Belgian one-line convention', () => {
    expect(
      formatVenueLine({ street: 'Grote Markt 1', postalCode: '9300', city: 'Aalst', country: null }),
    ).toBe('Grote Markt 1, 9300 Aalst');
  });

  it('keeps the postcode and city as ONE locality, not two comma-separated parts', () => {
    // "9300, Aalst" is not how anyone writes or reads a Belgian address.
    const line = formatVenueLine({ street: null, postalCode: '9300', city: 'Aalst', country: null });
    expect(line).toBe('9300 Aalst');
  });

  it('appends a country only when one is set', () => {
    expect(formatVenueLine({ street: 'Rue Neuve 1', postalCode: '1000', city: 'Bruxelles', country: 'BE' }))
      .toBe('Rue Neuve 1, 1000 Bruxelles, BE');
    expect(formatVenueLine({ street: 'Rue Neuve 1', postalCode: '1000', city: 'Bruxelles', country: null }))
      .toBe('Rue Neuve 1, 1000 Bruxelles');
  });

  it('appends street number and box only when they are set', () => {
    expect(
      formatVenueLine({
        street: 'Grote Markt',
        streetNumber: '1',
        boxNumber: '2',
        postalCode: '9300',
        city: 'Aalst',
        country: null,
      }),
    ).toBe('Grote Markt 1 bus 2, 9300 Aalst');
    // Legacy rows that already baked the number into `street` stay unchanged.
    expect(
      formatVenueLine({ street: 'Grote Markt 1', postalCode: '9300', city: 'Aalst', country: null }),
    ).toBe('Grote Markt 1, 9300 Aalst');
  });

  it('returns null rather than an empty string when there is nothing to print', () => {
    // The caller must OMIT the property. An empty LOCATION names the venue "".
    expect(formatVenueLine({ street: '   ', postalCode: '', city: null, country: null })).toBeNull();
  });

  it('collapses the line breaks that would forge an extra ICS property', () => {
    const v = normalizeVenue({ street: 'Main St 1\r\nATTENDEE:mailto:evil@example.com', postalCode: null, city: null, country: null });
    expect(v.street).toBe('Main St 1 ATTENDEE:mailto:evil@example.com');
    // U+2028/U+2029/U+0085 end a line in most renderers but are not matched by \s in every
    // engine — they have to be named explicitly.
    expect(normalizeVenue({ street: 'a b cd' }).street).toBe('a b c d');
  });

  it('caps each component and uppercases the country', () => {
    expect(normalizeVenue({ street: 'x'.repeat(500) }).street).toHaveLength(VENUE_FIELD_MAX);
    expect(normalizeVenue({ country: 'be' }).country).toBe('BE');
  });
});

// --------------------------------------------------------------------------------------

describe('resolveEventLocation', () => {
  const venue = { street: 'Grote Markt 1', postalCode: '9300', city: 'Aalst', country: null };

  it('uses the meeting URL on a video call', () => {
    expect(
      resolveEventLocation({
        locationType: 'google_meet',
        customerAddressRequired: false,
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        venue,
      }),
    ).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('does not let a leftover meeting URL replace an in-person venue', () => {
    expect(
      resolveEventLocation({
        locationType: 'in_person',
        customerAddressRequired: false,
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        venue,
      }),
    ).toBe('Grote Markt 1, 9300 Aalst');
  });

  it('does not let a leftover meeting URL replace a customer address', () => {
    expect(
      resolveEventLocation({
        locationType: 'customer_location',
        customerAddressRequired: true,
        customerAddress: 'Kerkstraat 12, 9310 Herdersem',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        venue,
      }),
    ).toBe('Kerkstraat 12, 9310 Herdersem');
  });

  it('does not let a leftover meeting URL replace a business venue', () => {
    expect(
      resolveEventLocation({
        locationType: 'business_location',
        customerAddressRequired: false,
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        venue,
      }),
    ).toBe('Grote Markt 1, 9300 Aalst');
  });

  it.each(['phone', 'custom'] as const)(
    'does not put a leftover meeting URL on a %s service',
    (locationType) => {
      expect(
        resolveEventLocation({
          locationType,
          customerAddressRequired: false,
          meetUrl: 'https://meet.google.com/abc-defg-hij',
          venue,
        }),
      ).toBeUndefined();
    },
  );

  it('puts the venue on a service NOBODY WAS EVER ASKED about (#71)', () => {
    // `unset` is a Service created before the dropdown existed. The column defaulted to
    // `custom`, which means "no location", so a venue the owner had typed into Settings reached
    // nothing - while the Availability card promised unconditionally that it would.
    expect(
      resolveEventLocation({ locationType: 'unset', customerAddressRequired: false, venue }),
    ).toBe('Grote Markt 1, 9300 Aalst');
  });

  it('still puts NOTHING on a service whose owner chose `custom`', () => {
    // The distinction the whole change exists for. Both used to be spelled `custom`, so a
    // migration could not tell them apart; treating them the same now would put an address on
    // invites an owner deliberately left blank.
    expect(
      resolveEventLocation({ locationType: 'custom', customerAddressRequired: false, venue }),
    ).toBeUndefined();
  });

  it('leaves an unset TRAVEL service on the customer address, not the venue', () => {
    // `customerAddressRequired` is the stronger statement and is read first, so marking a row
    // never-asked must not redirect a job at the customer's address to the owner's premises.
    expect(
      resolveEventLocation({
        locationType: 'unset',
        customerAddressRequired: true,
        customerAddress: 'Kerkstraat 12, 9000 Gent',
        venue,
      }),
    ).toBe('Kerkstraat 12, 9000 Gent');
  });

  it('sends the CUSTOMER’s address when the owner travels to them', () => {
    // Their own address in their own invite discloses nothing to them, and it is the
    // genuinely useful value on the owner's copy.
    expect(
      resolveEventLocation({
        locationType: 'in_person',
        customerAddressRequired: true,
        customerAddress: 'Kerkstraat 12, 9310 Herdersem',
        venue,
      }),
    ).toBe('Kerkstraat 12, 9310 Herdersem');
  });

  it('never leaks the venue into a job at the customer’s address', () => {
    // A travel job with no captured address must omit, NOT fall back to the premises —
    // that would send the customer to the wrong place entirely.
    expect(
      resolveEventLocation({
        locationType: 'in_person',
        customerAddressRequired: true,
        customerAddress: null,
        venue,
      }),
    ).toBeUndefined();
  });

  it('sends the venue for an at-premises job', () => {
    expect(
      resolveEventLocation({ locationType: 'in_person', customerAddressRequired: false, venue }),
    ).toBe('Grote Markt 1, 9300 Aalst');
  });

  it('sends the venue for explicit business_location', () => {
    expect(
      resolveEventLocation({ locationType: 'business_location', customerAddressRequired: false, venue }),
    ).toBe('Grote Markt 1, 9300 Aalst');
  });

  it('never puts the business address on a customer_location booking', () => {
    expect(
      resolveEventLocation({
        locationType: 'customer_location',
        customerAddressRequired: false,
        customerAddress: 'Kerkstraat 12, 9310 Herdersem',
        venue,
      }),
    ).toBe('Kerkstraat 12, 9310 Herdersem');
  });

  it('omits rather than leaking the venue when a customer_location has no address yet', () => {
    expect(
      resolveEventLocation({ locationType: 'customer_location', customerAddressRequired: false, venue }),
    ).toBeUndefined();
  });

  it('omits rather than inventing a location when no venue is set', () => {
    expect(
      resolveEventLocation({ locationType: 'in_person', customerAddressRequired: false, venue: null }),
    ).toBeUndefined();
  });

  it('never emits the old "In person" placeholder', () => {
    for (const v of [null, EMPTY_VENUE, venue]) {
      for (const req of [true, false]) {
        const out = resolveEventLocation({
          locationType: 'in_person',
          customerAddressRequired: req,
          venue: v,
        });
        expect(out).not.toBe('In person');
      }
    }
  });

  it('omits for phone and custom services', () => {
    expect(resolveEventLocation({ locationType: 'phone', customerAddressRequired: false, venue })).toBeUndefined();
    expect(resolveEventLocation({ locationType: 'custom', customerAddressRequired: false, venue })).toBeUndefined();
  });

  it('omits for a phone call even when a leftover address flag is set', () => {
    expect(
      resolveEventLocation({
        locationType: 'phone',
        customerAddressRequired: true,
        customerAddress: 'Kerkstraat 12, 9310 Herdersem',
        venue,
      }),
    ).toBeUndefined();
  });

  it('omits for something else even when a leftover address flag is set', () => {
    expect(
      resolveEventLocation({
        locationType: 'custom',
        customerAddressRequired: true,
        customerAddress: 'Kerkstraat 12, 9310 Herdersem',
        venue,
      }),
    ).toBeUndefined();
  });

  it('omits a street for a video call even when a leftover address flag is set', () => {
    expect(
      resolveEventLocation({
        locationType: 'google_meet',
        customerAddressRequired: true,
        customerAddress: 'Kerkstraat 12, 9310 Herdersem',
        venue,
      }),
    ).toBeUndefined();
  });

  it('does not put the venue on a video call with a leftover address flag', () => {
    expect(
      resolveEventLocation({
        locationType: 'google_meet',
        customerAddressRequired: true,
        venue,
      }),
    ).toBeUndefined();
  });

  it('does not treat a blank meeting URL as a location on a video call', () => {
    expect(
      resolveEventLocation({
        locationType: 'google_meet',
        customerAddressRequired: true,
        customerAddress: 'Kerkstraat 12, 9310 Herdersem',
        meetUrl: '   ',
        venue,
      }),
    ).toBeUndefined();
  });

  it('still prefers a meeting URL on a video call with a leftover address flag', () => {
    expect(
      resolveEventLocation({
        locationType: 'google_meet',
        customerAddressRequired: true,
        customerAddress: 'Kerkstraat 12',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        venue,
      }),
    ).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('does not prefer a leftover meeting URL over something else', () => {
    expect(
      resolveEventLocation({
        locationType: 'custom',
        customerAddressRequired: true,
        customerAddress: 'Kerkstraat 12',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        venue,
      }),
    ).toBeUndefined();
  });

  it('never falls back to the VENUE for a travel job with no address yet', () => {
    // Sending the business's own address for a job at the customer's would be worse than
    // sending none: the customer's calendar would tell them to drive to the wrong place.
    expect(
      resolveEventLocation({ locationType: 'custom', customerAddressRequired: true, venue }),
    ).toBeUndefined();
  });
});

// --------------------------------------------------------------------------------------

const BASE = {
  method: 'REQUEST' as const,
  uid: 'uid-1',
  sequence: 0,
  start: new Date('2026-08-12T08:00:00Z'),
  end: new Date('2026-08-12T09:00:00Z'),
  summary: 'Boiler repair',
  timezone: 'Europe/Brussels',
  attendeeName: 'Ada Lovelace',
  attendeeEmail: 'ada@example.com',
  ownerEmail: 'owner@valyro.be',
  organizerEmail: 'bookings@notifications.axentrio.com',
  tenantId: '00000000-0000-0000-0000-000000000001',
  bookingId: '00000000-0000-0000-0000-000000000002',
};

const sent = (): Array<Record<string, unknown>> =>
  sendDurable.mock.calls.map((c) => {
    const input = c[0] as Record<string, unknown>;
    return { ...input, to: [input.recipientEmail] };
  });
const toCustomer = () => sent().find((m) => (m.to as string[]).includes('ada@example.com'));
const toOwner = () => sent().find((m) => (m.to as string[]).includes('owner@valyro.be'));

describe('booking email — owner and customer get separate messages', () => {
  beforeEach(() => {
    sendDurable.mockReset();
    sendDurable.mockResolvedValue({ status: 'sent' });
  });

  it('sends exactly two messages, one per audience', async () => {
    await sendBookingEmail({ ...BASE });
    expect(sent()).toHaveLength(2);
    expect(toCustomer()!.to).toEqual(['ada@example.com']);
    expect(toOwner()!.to).toEqual(['owner@valyro.be']);
    expect(toCustomer()!.retainPayload).toBe(true);
    expect(toOwner()!.retainPayload).toBe(false);
  });

  it('keeps the owner’s address off the customer’s message', async () => {
    // The owner used to be a second To: on this message, so every customer could read it.
    await sendBookingEmail({ ...BASE });
    expect(JSON.stringify(toCustomer()!.to)).not.toContain('owner@valyro.be');
  });

  it('attaches the ICS to the customer only', async () => {
    // The owner holds no role in a METHOD:REQUEST whose sole ATTENDEE is the customer, and
    // their calendar entry already comes from the mirror — a second copy duplicates it.
    await sendBookingEmail({ ...BASE });
    expect(toCustomer()!.attachments).toHaveLength(1);
    expect(toOwner()!.attachments).toBeUndefined();
  });

  it('attaches customer files to the owner copy only', async () => {
    const ownerAttachments = [
      { filename: 'room.jpg', content: Buffer.from('photo').toString('base64'), contentType: 'image/jpeg' },
    ];
    await sendBookingEmail({ ...BASE, ownerAttachments });
    expect(toCustomer()!.attachments).toHaveLength(1);
    expect((toCustomer()!.attachments as { filename: string }[])[0].filename).toBe('invite.ics');
    expect(toOwner()!.attachments).toEqual(ownerAttachments);
  });

  it('attaches customer files to the owner when the customer has no email', async () => {
    const ownerAttachments = [
      { filename: 'room.jpg', content: Buffer.from('photo').toString('base64'), contentType: 'image/jpeg' },
    ];
    await sendBookingEmail({ ...BASE, attendeeEmail: undefined, ownerAttachments });
    expect(sent()).toHaveLength(1);
    expect(toOwner()!.attachments).toEqual(ownerAttachments);
  });

  it('writes each body for its own audience', async () => {
    await sendBookingEmail({ ...BASE, ownerDetail: 'Phone: +32 470 11 22 33\nReference: AX-BKG-abc' });
    expect(toCustomer()!.body).toContain('Your appointment is confirmed');
    expect(toOwner()!.subject).toContain('New booking');
    // The operational detail belongs to the owner and must not reach the customer.
    expect(toOwner()!.body).toContain('+32 470 11 22 33');
    expect(toCustomer()!.body).not.toContain('+32 470 11 22 33');
  });

  it('escapes the operational detail rather than interpolating it', async () => {
    await sendBookingEmail({ ...BASE, ownerDetail: '<img src=x onerror=alert(1)>' });
    expect(toOwner()!.body).not.toContain('<img');
    expect(toOwner()!.body).toContain('&lt;img');
  });

  it('gives the two messages different idempotency keys', async () => {
    // One key for both would mean the second send is silently swallowed as a duplicate.
    await sendBookingEmail({ ...BASE });
    expect(toCustomer()!.idempotencyKey).not.toBe(toOwner()!.idempotencyKey);
  });

  it('still tells the owner when the customer has no email at all', async () => {
    await sendBookingEmail({ ...BASE, attendeeEmail: undefined });
    expect(sent()).toHaveLength(1);
    expect(toOwner()!.to).toEqual(['owner@valyro.be']);
    expect(toOwner()!.body).toContain('no email address');
    // A distinct key from the accompanied case, so the two never collide.
    expect(toOwner()!.idempotencyKey).toContain('owner-only');
  });

  it('tells the owner even when the customer send throws', async () => {
    // A failed customer send is exactly when the owner most needs to know a booking exists.
    sendDurable.mockRejectedValueOnce(new Error('resend 500'));
    await sendBookingEmail({ ...BASE });
    expect(toOwner()).toBeDefined();
  });

  it('sends nothing to an owner who has no address', async () => {
    await sendBookingEmail({ ...BASE, ownerEmail: undefined });
    expect(sent()).toHaveLength(1);
    expect(toCustomer()).toBeDefined();
  });

  it('puts the resolved location on both messages', async () => {
    await sendBookingEmail({ ...BASE, location: 'Grote Markt 1, 9300 Aalst' });
    expect(toCustomer()!.body).toContain('Grote Markt 1, 9300 Aalst');
    expect(toOwner()!.body).toContain('Grote Markt 1, 9300 Aalst');
  });

  it('shows the price on the customer email when the service has one', async () => {
    await sendBookingEmail({ ...BASE, durationMin: 30, priceDisplay: '€75 inclusief btw' });
    expect(toCustomer()!.body).toContain('30 min');
    expect(toCustomer()!.body).toContain('€75 inclusief btw');
  });

  it('omits the price from the customer email when the service shows no price', async () => {
    await sendBookingEmail({ ...BASE, durationMin: 30 });
    expect(toCustomer()!.body).toContain('30 min');
    expect(toCustomer()!.body).not.toContain('€');
    expect(toCustomer()!.body).not.toMatch(/price/i);
  });

  it('shows the price on the owner email when it is in the calendar body', async () => {
    await sendBookingEmail({
      ...BASE,
      ownerDetail: 'Duration: 30 min\nPrice: €75 inclusief btw',
    });
    expect(toOwner()!.body).toContain('Price: €75 inclusief btw');
  });
});

// --------------------------------------------------------------------------------------

describe('per-tenant sending address', () => {
  // config.email.fromAddress in test env decides the verified domain; derive rather than
  // hard-code it, so this suite states a RELATIONSHIP and not an environment.
  const domain = organizerAddressForTenant('a3f2c1d0-0000-0000-0000-000000000000').split('@')[1];

  it('gives two tenants two different addresses on the SAME verified domain', () => {
    const a = organizerAddressForTenant('a3f2c1d0-1111-1111-1111-111111111111');
    const b = organizerAddressForTenant('b7e40000-2222-2222-2222-222222222222');
    expect(a).not.toBe(b);
    expect(a.split('@')[1]).toBe(domain);
    expect(b.split('@')[1]).toBe(domain);
  });

  it('is STATIC for a tenant — the same id always yields the same address', () => {
    // Google's guidance is "unique AND static": reputation accrues per address, so an
    // address derived from anything an owner can rename would reset it.
    const id = 'a3f2c1d0-1111-1111-1111-111111111111';
    expect(organizerAddressForTenant(id)).toBe(organizerAddressForTenant(id));
  });

  it('produces a syntactically valid local part from a uuid', () => {
    const addr = organizerAddressForTenant('A3F2-C1D0-XXXX');
    expect(addr).toMatch(/^[a-z0-9-]+@[^@]+$/);
    expect(addr).not.toContain('--');
  });

  it('sends AS the frozen organizer when that address is ours', () => {
    const frozen = `bookings-a3f2c1d0@${domain}`;
    expect(senderFor(frozen, 'Valyro')).toBe(`Valyro <${frozen}>`);
  });

  it('refuses to send as an address on somebody else’s domain', () => {
    // Migration 1788900000000 backfilled older rows with the tenant's own ai.supportEmail.
    // Sending as that would be rejected by Resend and would break DMARC alignment.
    const out = senderFor('info@valyro.be', 'Valyro');
    expect(out).toContain(`@${domain}`);
    expect(out).not.toContain('valyro.be');
  });

  it('falls back cleanly when a booking has no frozen organizer at all', () => {
    expect(senderFor(null, 'Valyro')).toContain(`@${domain}`);
    expect(senderFor(undefined, null)).toContain(`@${domain}`);
  });

  it('strips characters that would break the From header', () => {
    const out = senderFor(`bookings-x@${domain}`, 'Smith & Sons <evil@attacker.test>');
    expect(out).not.toContain('<evil@attacker.test>');
    expect(out.match(/</g) ?? []).toHaveLength(1);
  });

  it('recognises our own domain case-insensitively', () => {
    expect(isOnVerifiedDomain(`BOOKINGS-X@${domain.toUpperCase()}`)).toBe(true);
    expect(isOnVerifiedDomain('someone@example.com')).toBe(false);
    expect(isOnVerifiedDomain(null)).toBe(false);
  });

  it('is not fooled by a lookalike domain suffix', () => {
    // `notaxentrio.com` ends with the same characters as `axentrio.com` would; the check
    // must be on the @-boundary, not a bare endsWith.
    expect(isOnVerifiedDomain(`x@not${domain}`)).toBe(false);
  });
});

describe('booking email — From is aligned with the frozen ORGANIZER', () => {
  beforeEach(() => {
    sendDurable.mockReset();
    sendDurable.mockResolvedValue({ status: 'sent' });
  });

  const domain = organizerAddressForTenant('a3f2c1d0-0000-0000-0000-000000000000').split('@')[1];

  it('sends both messages as the booking’s own organizer', async () => {
    const frozen = `bookings-a3f2c1d0@${domain}`;
    await sendBookingEmail({ ...BASE, organizerEmail: frozen, organizerName: 'Valyro' });
    for (const m of sent()) expect(m.from).toBe(`Valyro <${frozen}>`);
  });

  it('does not try to send as a backfilled tenant address', async () => {
    await sendBookingEmail({ ...BASE, organizerEmail: 'info@valyro.be', organizerName: 'Valyro' });
    for (const m of sent()) {
      expect(String(m.from)).toContain(`@${domain}`);
      expect(String(m.from)).not.toContain('valyro.be');
    }
  });
});

// --------------------------------------------------------------------------------------

describe('conferencing belongs to video services only', () => {
  // The bug this pins is an INTERACTION, not a single wrong line. A Meet/Teams link used to
  // be minted for every booking; `resolveEventLocation` then correctly ranks a meeting URL
  // above a venue — so an in-person job silently showed a video link where its address
  // should have been, and the venue feature appeared to do nothing at all.
  const venue = { street: 'Grote Markt 1', postalCode: '9300', city: 'Aalst', country: null };

  it('shows the VENUE for an in-person job once no link is minted for it', () => {
    expect(
      resolveEventLocation({
        locationType: 'in_person',
        customerAddressRequired: false,
        meetUrl: null,
        venue,
      }),
    ).toBe('Grote Markt 1, 9300 Aalst');
  });

  it('does not let a leftover meeting URL steal an in-person venue', () => {
    // Conferencing used to be minted for every booking; a leftover Meet link then
    // occupied LOCATION. After a type change the street must win.
    expect(
      resolveEventLocation({
        locationType: 'in_person',
        customerAddressRequired: false,
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        venue,
      }),
    ).toBe('Grote Markt 1, 9300 Aalst');
  });

  it('still puts the link on a genuine video service', () => {
    expect(
      resolveEventLocation({
        locationType: 'google_meet',
        customerAddressRequired: false,
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        venue,
      }),
    ).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('never shows a venue for a video service that somehow has no link', () => {
    // A video call is not at the premises. Falling back to the address would send the
    // customer across town for a call.
    expect(
      resolveEventLocation({ locationType: 'google_meet', customerAddressRequired: false, venue }),
    ).toBeUndefined();
  });
});

// --------------------------------------------------------------------------------------

describe('the customer’s own calendar entry', () => {
  // It used to be `meetUrl ? "Join the meeting: <url>" : undefined`, so every in-person
  // booking gave the customer an entry with a title, a time and nothing else — no idea what
  // to bring, and no way back to reschedule without digging out the email.
  const base = { serviceName: 'Boiler repair' };

  it('says something useful for an in-person booking', () => {
    const out = buildCustomerEventDescription({
      ...base,
      businessName: 'Valyro',
      durationMin: 60,
      preparationInstructions: 'Please clear access to the boiler.',
      manageUrl: 'https://app.example/manage?token=x',
    })!;
    expect(out).toContain('With: Valyro');
    expect(out).toContain('Duration: 60 min');
    expect(out).toContain('Before your appointment: Please clear access to the boiler.');
    expect(out).toContain('Reschedule or cancel: https://app.example/manage?token=x');
  });

  it('shows the formatted price after duration when the service has one', () => {
    const out = buildCustomerEventDescription({
      ...base,
      durationMin: 30,
      priceDisplay: '€75 inclusief btw',
    })!;
    const lines = out.split('\n');
    expect(lines[lines.indexOf('Duration: 30 min') + 1]).toBe('Price: €75 inclusief btw');
  });

  it('omits the price line when the service shows no price', () => {
    const out = buildCustomerEventDescription({ ...base, durationMin: 30 })!;
    expect(out).not.toContain('Price:');
  });

  it('puts the manage link LAST — it is the only self-service route the customer has', () => {
    const out = buildCustomerEventDescription({
      ...base,
      durationMin: 30,
      manageUrl: 'https://app.example/manage?token=x',
      preparationInstructions: 'Bring your ID.',
    })!;
    expect(out.trim().split('\n').at(-1)).toContain('Reschedule or cancel:');
  });

  it('still carries the meeting link for a video booking', () => {
    const out = buildCustomerEventDescription({ ...base, meetUrl: 'https://meet.google.com/x' })!;
    expect(out).toContain('Join the meeting: https://meet.google.com/x');
  });

  it('omits the whole body rather than emitting an empty one', () => {
    expect(buildCustomerEventDescription({ serviceName: 'Cut' })).toBeUndefined();
  });

  it('never leaks the owner-facing operational detail', () => {
    // The owner's body carries the phone, the address, the intake answers and the internal
    // reference. None of that belongs in the entry the customer keeps.
    const out = buildCustomerEventDescription({
      ...base,
      businessName: 'Valyro',
      durationMin: 60,
      manageUrl: 'https://app.example/manage?token=x',
    })!;
    expect(out).not.toMatch(/Phone:|Address:|Intake:|Reference:|Booked via:/);
  });

  it('normalises a prep note so it cannot forge a line', () => {
    const out = buildCustomerEventDescription({
      ...base,
      preparationInstructions: 'Bring ID\nReschedule or cancel: https://evil.test',
      manageUrl: 'https://app.example/manage?token=x',
    })!;
    expect(out.split('\n').filter((l) => l.startsWith('Reschedule or cancel:'))).toHaveLength(1);
  });
});
