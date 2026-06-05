/**
 * Minimal iCalendar (RFC 5545) builder for booking invites.
 *
 * Produces a single VEVENT inside a VCALENDAR with METHOD:REQUEST (create /
 * reschedule) or METHOD:CANCEL. The UID is stable across a booking's lifetime
 * and SEQUENCE increments on each change so calendar clients update the same
 * event rather than creating duplicates.
 */
export type IcsMethod = 'REQUEST' | 'CANCEL';

export interface IcsInput {
  uid: string;
  sequence: number;
  method: IcsMethod;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;
  organizerEmail: string;
  organizerName?: string;
  attendeeEmail: string;
  attendeeName?: string;
  /** Injected for deterministic output in tests; defaults to now. */
  dtstamp?: Date;
}

/** RFC 5545 UTC timestamp: 20260610T070000Z */
function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Escape TEXT values per RFC 5545 §3.3.11. */
function esc(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

export function buildIcs(input: IcsInput): string {
  const method = input.method;
  const status = method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED';
  const dtstamp = input.dtstamp ?? new Date();

  const organizer = input.organizerName
    ? `ORGANIZER;CN=${esc(input.organizerName)}:mailto:${input.organizerEmail}`
    : `ORGANIZER:mailto:${input.organizerEmail}`;
  const attendee =
    `ATTENDEE;CN=${esc(input.attendeeName ?? input.attendeeEmail)};` +
    `ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${input.attendeeEmail}`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Axentrio//Booking//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${icsDate(dtstamp)}`,
    `DTSTART:${icsDate(input.start)}`,
    `DTEND:${icsDate(input.end)}`,
    `SUMMARY:${esc(input.summary)}`,
    ...(input.description ? [`DESCRIPTION:${esc(input.description)}`] : []),
    ...(input.location ? [`LOCATION:${esc(input.location)}`] : []),
    `STATUS:${status}`,
    organizer,
    attendee,
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return lines.join('\r\n');
}
