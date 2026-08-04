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

/**
 * RFC 5545 §3.1: no content line may exceed 75 OCTETS, and continuations begin with a
 * single space.
 *
 * Nothing enforced this before, which was survivable only because DESCRIPTION never held
 * more than "Join the meeting: <url>". A richer description immediately produces over-long
 * lines, and strict parsers (Outlook desktop, several CalDAV servers) mangle or reject the
 * event rather than wrapping it themselves. Folding is done on OCTETS, backing off a
 * multi-byte UTF-8 sequence so a fold never lands mid-character.
 */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  // First line gets 75 octets; continuations lose one to the leading space.
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }
  return parts.join('\r\n ');
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

  return lines.map(fold).join('\r\n');
}
