/**
 * Regression: the ICS ORGANIZER must be a BARE email in the mailto:, even when
 * the configured from-address is a full "Name <email>" string. A malformed
 * `ORGANIZER:mailto:Name <email>` made Gmail show "Unable to load event".
 */
import { describe, it, expect } from 'vitest';
import { parseAddress } from '../../n8n/booking-providers/booking-email';
import { buildIcs } from '../../n8n/booking-providers/ics';

describe('parseAddress', () => {
  it('splits "Name <email>" into a bare email + name', () => {
    expect(parseAddress('Axentrio Bookings <bookings@notifications.axentrio.com>')).toEqual({
      email: 'bookings@notifications.axentrio.com',
      name: 'Axentrio Bookings',
    });
  });
  it('strips surrounding quotes from the name', () => {
    expect(parseAddress('"Axentrio, Inc." <b@x.io>')).toEqual({ email: 'b@x.io', name: 'Axentrio, Inc.' });
  });
  it('leaves a bare email unchanged', () => {
    expect(parseAddress('owner@acme.com')).toEqual({ email: 'owner@acme.com' });
  });
});

describe('ICS organizer is a valid mailto', () => {
  it('produces ORGANIZER;CN=<name>:mailto:<bare-email> from a "Name <email>" source', () => {
    const org = parseAddress('Axentrio Bookings <bookings@notifications.axentrio.com>');
    const ics = buildIcs({
      uid: 'u@axentrio',
      sequence: 0,
      method: 'REQUEST',
      start: new Date('2026-06-09T13:00:00Z'),
      end: new Date('2026-06-09T13:30:00Z'),
      summary: 'Intro call',
      organizerEmail: org.email,
      organizerName: org.name,
      attendeeEmail: 'sam@example.com',
      dtstamp: new Date('2026-06-09T09:00:00Z'),
    });
    expect(ics).toContain('ORGANIZER;CN=Axentrio Bookings:mailto:bookings@notifications.axentrio.com');
    // The mailto must NOT contain the display name / angle brackets.
    expect(ics).not.toMatch(/mailto:[^\r\n]*[<>]/);
  });
});
