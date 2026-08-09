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

const send = vi.fn();
// booking-email constructs its own `new EmailService(...)` and caches it, so the class is
// what has to be replaced — there is no injectable accessor to stub.
vi.mock('../../automations/email.service', () => ({
  EmailService: class {
    send(...a: unknown[]) {
      return send(...a);
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

  it('uses the meeting URL when there is one, whatever the service says', () => {
    expect(
      resolveEventLocation({
        locationType: 'in_person',
        customerAddressRequired: false,
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        venue,
      }),
    ).toBe('https://meet.google.com/abc-defg-hij');
  });

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

  it('omits rather than inventing a location when no venue is set', () => {
    // This is the grandfathered state for every existing tenant, and it must be silent.
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

  it("uses the customer's address even when locationType was never set away from 'custom'", () => {
    // `custom` is the default the column shipped with, so every service created by hand
    // before the dropdown existed still carries it and no migration ever backfilled them.
    // Checking locationType first meant a service that geocodes and REFUSES bookings outside
    // the service area — on customerAddressRequired alone — simultaneously put no address on
    // the invite at all. The two authorities have to agree about what kind of job it is.
    expect(
      resolveEventLocation({
        locationType: 'custom',
        customerAddressRequired: true,
        customerAddress: 'Kerkstraat 12, 9310 Herdersem',
        venue,
      }),
    ).toBe('Kerkstraat 12, 9310 Herdersem');
  });

  it('still prefers a meeting URL over the customer address', () => {
    expect(
      resolveEventLocation({
        locationType: 'custom',
        customerAddressRequired: true,
        customerAddress: 'Kerkstraat 12',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        venue,
      }),
    ).toBe('https://meet.google.com/abc-defg-hij');
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
};

const sent = () => send.mock.calls.map((c) => c[0] as Record<string, unknown>);
const toCustomer = () => sent().find((m) => (m.to as string[]).includes('ada@example.com'));
const toOwner = () => sent().find((m) => (m.to as string[]).includes('owner@valyro.be'));

describe('booking email — owner and customer get separate messages', () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue(undefined);
  });

  it('sends exactly two messages, one per audience', async () => {
    await sendBookingEmail({ ...BASE });
    expect(sent()).toHaveLength(2);
    expect(toCustomer()!.to).toEqual(['ada@example.com']);
    expect(toOwner()!.to).toEqual(['owner@valyro.be']);
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
    send.mockRejectedValueOnce(new Error('resend 500'));
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
    send.mockReset();
    send.mockResolvedValue(undefined);
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

  it('would have shown the meeting URL instead — the defect, reproduced', () => {
    // Exactly what happened before conferencing was gated: same in-person service, but a
    // link exists because one was minted unconditionally.
    expect(
      resolveEventLocation({
        locationType: 'in_person',
        customerAddressRequired: false,
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        venue,
      }),
    ).toBe('https://meet.google.com/abc-defg-hij');
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
