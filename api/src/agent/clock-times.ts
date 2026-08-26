import { DateTime } from 'luxon';

export interface ClockTime {
  written: string;
  key: string;
  ambiguous: boolean;
  hour: number;
  minute: number;
  /**
   * The reading used a decimal point ("14.00"), which is also how a price is written.
   *
   * Only the SINGLE-time guard consults this, and only to stand down: "the call-out is 14.00
   * euro" beside a slot list would otherwise be replaced as an invented time.
   */
  dotted: boolean;
}

/**
 * Clock readings in `text`, in the same shape `unofferedTimesIn` has always used.
 *
 * Minutes are optional ONLY when a meridiem follows, so "3 slots", "45 EUR" and "17 August"
 * stay prose.
 */
export function parseClockTimes(text: string): ClockTime[] {
  // `9:00`, `09:30`, `1:30 PM`, `13.00`, and — since 2026-08-13 — `9 AM` and `9a.m.`.
  // The meridiem alternatives are deliberately symmetric — `a.m.` / `a.m` OR `am`, never `am.`.
  const found = [...text.matchAll(/\b(\d{1,2})(?:([:.])(\d{2}))?\s*([ap]\.m\.?|[ap]m)?/gi)];
  const times: ClockTime[] = [];
  for (const m of found) {
    const suffix = (m[4] ?? '').toLowerCase().replace(/\./g, '');
    const hasMinutes = m[3] !== undefined;
    if (!hasMinutes && !suffix) continue; // a bare number is not a time
    let hour = Number(m[1]);
    const minute = hasMinutes ? Number(m[3]) : 0;
    if (hour > 23 || minute > 59) continue;
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    times.push({
      written: m[0].trim(),
      key: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      ambiguous: suffix === '',
      hour,
      minute,
      dotted: m[2] === '.',
    });
  }
  return times;
}

function offeredKeyFor(t: ClockTime, offered: Set<string>): string | null {
  if (offered.has(t.key)) return t.key;
  // A 12-hour time with no suffix is ambiguous — "1:30" could be 13:30.
  if (t.ambiguous && t.hour < 12) {
    const alt = `${String(t.hour + 12).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
    if (offered.has(alt)) return alt;
  }
  return null;
}

/**
 * "11:30 to 12:30" names ONE appointment, not two offered times.
 *
 * A booked span's END is never a slot start, so a guard that reads both halves replaces a
 * perfectly correct confirmation: "Perfect, 16:00 to 17:00 on Friday" flags 17:00 the moment the
 * day's last slot ends at closing time, and on any granularity where no slot begins where the
 * previous one ends. Collapsing to the start keeps the sentence judged - the start still has to
 * be a time somebody offered - without inventing a rule about end times nobody offers.
 *
 * The separators are the ones the platform's languages actually write, plus the dashes. Anything
 * unmatched simply stays two readings, which is the behaviour before this existed.
 */
// The meridiem alternation is `parseClockTimes`' own, deliberately: `a.m.` / `a.m` OR `am`, never
// `am.` - so a sentence's full stop is left where the author put it.
const NAMED_SPAN =
  /(\d{1,2}[:.]\d{2}\s*(?:[ap]\.m\.?|[ap]m)?)\s*(?:-|–|—|to|tot|t\/m|until|till|à|bis|hasta|até)\s*\d{1,2}[:.]\d{2}\s*(?:[ap]\.m\.?|[ap]m)?/gi;

export function collapseSpans(text: string): string {
  return text.replace(NAMED_SPAN, '$1');
}

/**
 * The one clock time a text names, or null when it names none or several.
 *
 * "Several" counts DISTINCT readings, so a reply that says 10:30 twice still names one time.
 */
function singleNamedClockTime(text: string): ClockTime | null {
  const times = parseClockTimes(text);
  if (times.length === 0) return null;
  const distinct = new Set(times.map((t) => t.key));
  return distinct.size === 1 ? times[0] : null;
}

/**
 * Times the reply NAMES that were never offered.
 *
 * NARROW ON PURPOSE, because the cost of firing wrongly is replacing a good reply. It only looks
 * at replies that are ENUMERATING (two or more clock times), and only ever compares against a list
 * we just offered. A single time in prose — "we open at 9:00" — is left alone.
 */
export function unofferedTimesIn(text: string, offeredLocal: string[]): string[] {
  const times = parseClockTimes(text);
  // Only ENUMERATIONS are judged. One time in prose — "we open at 08:00" — is a fact about the
  // business, and replacing that reply is worse than leaving it.
  if (times.length < 2) return [];

  const offered = new Set(offeredLocal);
  const named: string[] = [];
  for (const t of times) {
    if (offeredKeyFor(t, offered) === null) named.push(t.written);
  }
  return named;
}

/**
 * Whether `text` names exactly one clock time, and that time is in `offeredLocal`.
 *
 * Used to stop re-offering hours the customer already chose (a named time, or a tapped slot
 * chip whose payload is "Book … at 10:00 AM").
 */
export function namesSingleOfferedTime(text: string, offeredLocal: string[]): boolean {
  const named = singleNamedClockTime(text);
  return !!named && offeredKeyFor(named, new Set(offeredLocal)) !== null;
}

/**
 * The ONE time a reply names that nobody offered, or null.
 *
 * `unofferedTimesIn` above judges enumerations only, and that exemption cost a live booking on
 * 2026-08-26: the bot answered "the next valid time is 08:30" — the first offered slot's UTC
 * instant read as a wall clock — above chips that said 10:30. One invented time is not a stray
 * item in a list, it IS the whole recommendation, so it gets judged on its own.
 *
 * Judged against EVERY offered slot rather than the delivered chip prefix, unlike the
 * enumeration guard. A time further down the list is one `create_booking` will accept, so
 * confirming it is right; a time nobody offered is an invention whatever the channel showed.
 *
 * A decimal-point reading with no meridiem stands down, because that is also how a price is
 * written ("the call-out is 14.00 euro") and this guard replaces the whole reply.
 */
export function unofferedSingleTimeIn(text: string, offeredLocal: string[]): string | null {
  const named = singleNamedClockTime(text);
  if (!named || (named.dotted && named.ambiguous)) return null;
  if (offeredKeyFor(named, new Set(offeredLocal)) !== null) return null;
  return named.written;
}

/** Local `HH:mm` for each slot, or null if any start time will not parse. */
export function localClockTimes(
  slots: Array<{ start: string }>,
  timezone: string,
): string[] | null {
  const times = slots.map((s) => DateTime.fromISO(s.start).setZone(timezone));
  if (!times.every((t) => t.isValid)) return null;
  return times.map((t) => t.toFormat('HH:mm'));
}
