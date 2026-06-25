import { describe, it, expect } from 'vitest';
import { buildIcs } from '../../booking/booking-providers/ics';

const base = {
  uid: 'abc-123@axentrio',
  start: new Date('2026-06-10T07:00:00Z'),
  end: new Date('2026-06-10T07:30:00Z'),
  summary: 'Intro call',
  organizerEmail: 'owner@axentrio.be',
  attendeeEmail: 'ada@example.com',
  attendeeName: 'Ada Lovelace',
  dtstamp: new Date('2026-06-05T12:00:00Z'),
};

describe('ics · buildIcs', () => {
  it('builds a REQUEST VEVENT with UTC times, uid, and sequence', () => {
    const ics = buildIcs({ ...base, method: 'REQUEST', sequence: 0 });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('UID:abc-123@axentrio');
    expect(ics).toContain('SEQUENCE:0');
    expect(ics).toContain('DTSTART:20260610T070000Z');
    expect(ics).toContain('DTEND:20260610T073000Z');
    expect(ics).toContain('DTSTAMP:20260605T120000Z');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).toContain('ATTENDEE;CN=Ada Lovelace');
    expect(ics).toContain('mailto:ada@example.com');
    expect(ics).toContain('ORGANIZER:mailto:owner@axentrio.be');
    expect(ics.endsWith('END:VCALENDAR')).toBe(true);
    // CRLF line endings per RFC 5545
    expect(ics).toContain('\r\n');
  });

  it('builds a CANCEL with incremented sequence and CANCELLED status', () => {
    const ics = buildIcs({ ...base, method: 'CANCEL', sequence: 2 });
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics).toContain('STATUS:CANCELLED');
    // same UID → clients update the same event
    expect(ics).toContain('UID:abc-123@axentrio');
  });

  it('escapes special characters in text values', () => {
    const ics = buildIcs({
      ...base,
      method: 'REQUEST',
      sequence: 0,
      summary: 'Demo; with, special\\chars',
    });
    expect(ics).toContain('SUMMARY:Demo\\; with\\, special\\\\chars');
  });
});
