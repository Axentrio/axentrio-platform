import { DateTime } from 'luxon';

export interface ClockTime {
  written: string;
  key: string;
  ambiguous: boolean;
  hour: number;
  minute: number;
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
  const found = [...text.matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap]\.m\.?|[ap]m)?/gi)];
  const times: ClockTime[] = [];
  for (const m of found) {
    const suffix = (m[3] ?? '').toLowerCase().replace(/\./g, '');
    const hasMinutes = m[2] !== undefined;
    if (!hasMinutes && !suffix) continue; // a bare number is not a time
    let hour = Number(m[1]);
    const minute = hasMinutes ? Number(m[2]) : 0;
    if (hour > 23 || minute > 59) continue;
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    times.push({
      written: m[0].trim(),
      key: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      ambiguous: suffix === '',
      hour,
      minute,
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
  const times = parseClockTimes(text);
  if (times.length === 0) return false;
  const uniqueWritten = new Set(times.map((t) => t.key));
  if (uniqueWritten.size !== 1) return false;
  const offered = new Set(offeredLocal);
  const matched = new Set<string>();
  for (const t of times) {
    const key = offeredKeyFor(t, offered);
    if (key) matched.add(key);
  }
  return matched.size === 1;
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
