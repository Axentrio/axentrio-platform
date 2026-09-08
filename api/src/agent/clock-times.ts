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
  const hits: Array<{ index: number; time: ClockTime }> = [];
  for (const m of text.matchAll(/\b(\d{1,2})(?:([:.])(\d{2}))?\s*([ap]\.m\.?|[ap]m)?/gi)) {
    const suffix = (m[4] ?? '').toLowerCase().replace(/\./g, '');
    const hasMinutes = m[3] !== undefined;
    if (!hasMinutes && !suffix) continue; // a bare number is not a time
    let hour = Number(m[1]);
    const minute = hasMinutes ? Number(m[3]) : 0;
    if (hour > 23 || minute > 59) continue;
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    hits.push({
      index: m.index ?? 0,
      time: {
        written: m[0].trim(),
        key: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        ambiguous: suffix === '',
        hour,
        minute,
        dotted: m[2] === '.',
      },
    });
  }
  // Words, not digits. "later at midnight" on a 24/7 diary is 00:00 — and after 00:00 that
  // is the next calendar day, which a same-day slot walk cannot see.
  for (const re of [/\bmiddernacht\b/gi, /\bmid[\s-]?night\b/gi, /\bminuit\b/gi]) {
    for (const m of text.matchAll(re)) {
      hits.push({
        index: m.index ?? 0,
        time: {
          written: m[0],
          key: '00:00',
          ambiguous: false,
          hour: 0,
          minute: 0,
          dotted: false,
        },
      });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map((h) => h.time);
}

/**
 * The newest customer text that names a clock time, inside this booking attempt.
 *
 * Intake answers, names, and "yes" sit AFTER the hour they already gave. Reading only the last
 * user turn then forgets that hour, and the booking tools re-offer times they already chose.
 * A later message that names a different hour still wins: they changed their mind.
 *
 * STOP at the newest assistant turn that lists two or more clock times. That is an availability
 * offer (or a refusal that named alternatives). Walking past it would resurrect an hour they
 * already lost, and `resolveBookingTime` would then book it on a bare "yes".
 */
export function latestCustomerTimeText(
  messagesOldestFirst: ReadonlyArray<{ role: string; text: string }>,
): string {
  for (let i = messagesOldestFirst.length - 1; i >= 0; i--) {
    const m = messagesOldestFirst[i];
    if (m.role === 'assistant') {
      const distinct = new Set(parseClockTimes(m.text).map((t) => t.key));
      if (distinct.size >= 2) return '';
      continue;
    }
    if (m.role === 'user' && parseClockTimes(m.text).length > 0) return m.text;
  }
  return '';
}

/**
 * Midnight after 00:00 is 00:00 of the NEXT calendar day.
 *
 * A same-day availability read cannot contain that hour: today's 00:00 is already past,
 * and 24:00 is an end, not a start. Returns that next day when they named midnight
 * with no calendar date, `startDate` is business-local today, and the current offer has
 * no 00:00. A missing 00:00 on a future date means that night is busy or closed — not
 * the wrong day.
 */
export function upcomingMidnightDate(
  startDate: string,
  endDate: string,
  offeredLocal: readonly string[],
  customerText: string,
  timezone: string,
  now: Date,
): string | null {
  if (startDate !== endDate) return null;
  const keys = new Set(parseClockTimes(customerText).map((t) => t.key));
  if (keys.size !== 1 || !keys.has('00:00')) return null;
  const year = Number(startDate.slice(0, 4));
  if (!Number.isFinite(year) || parseCalendarDates(customerText, year).length > 0) return null;
  if (offeredLocal.includes('00:00')) return null;
  const today = DateTime.fromJSDate(now).setZone(timezone);
  if (!today.isValid || startDate !== today.toFormat('yyyy-MM-dd')) return null;
  return today.plus({ days: 1 }).toFormat('yyyy-MM-dd');
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

const RELATIVE_DAY_NEEDLES: Array<{ needles: string[]; offsetDays: number }> = [
  { needles: ['vandaag', 'today', "aujourd'hui", 'aujourdhui'], offsetDays: 0 },
  { needles: ['morgen', 'tomorrow', 'demain'], offsetDays: 1 },
  { needles: ['gisteren', 'yesterday', 'hier'], offsetDays: -1 },
  { needles: ['overmorgen', 'day after tomorrow', 'après-demain', 'apres-demain'], offsetDays: 2 },
];

/** Relative calendar days named in customer text (`vandaag`, `tomorrow`, …). */
export function parseRelativeCalendarDates(text: string, timezone: string, now: Date): string[] {
  const lower = text.toLowerCase();
  const today = DateTime.fromJSDate(now).setZone(timezone);
  if (!today.isValid) return [];
  const out: string[] = [];
  for (const { needles, offsetDays } of RELATIVE_DAY_NEEDLES) {
    if (needles.some((needle) => lower.includes(needle))) {
      out.push(today.plus({ days: offsetDays }).toFormat('yyyy-MM-dd'));
    }
  }
  return out;
}

/** Whether the customer anchored their hour to a specific calendar day or weekday. */
export function hasNamedCalendarAnchor(text: string, timezone: string, now: Date): boolean {
  const year = DateTime.fromJSDate(now).setZone(timezone).year;
  return (
    parseRelativeCalendarDates(text, timezone, now).length > 0 ||
    parseCalendarDates(text, year).length > 0 ||
    parseWeekdays(text).length > 0
  );
}

function resolveNamedDates(text: string, timezone: string, now: Date): { dates: string[]; weekdays: number[] } {
  const zoneToday = DateTime.fromJSDate(now).setZone(timezone);
  const year = zoneToday.isValid ? zoneToday.year : now.getUTCFullYear();
  const dates = [...new Set([...parseRelativeCalendarDates(text, timezone, now), ...parseCalendarDates(text, year)])];
  return { dates, weekdays: parseWeekdays(text) };
}

function filterSlotsByNamedDay(
  slots: Array<{ start: string }>,
  timezone: string,
  dates: string[],
  weekdays: number[],
): Array<{ start: string }> {
  if (dates.length === 0 && weekdays.length === 0) return slots;
  return slots.filter((slot) => {
    const dt = DateTime.fromISO(slot.start).setZone(timezone);
    if (!dt.isValid) return false;
    if (dates.length > 0 && !dates.includes(dt.toFormat('yyyy-MM-dd'))) return false;
    if (weekdays.length > 0 && !weekdays.includes(dt.weekday)) return false;
    return true;
  });
}

/** Zero-padded hours (`01:00`) are explicit AM; `1:30` may still mean PM. */
function allowPmAltFor(clock: ClockTime): boolean {
  if (!clock.ambiguous || clock.hour >= 12) return false;
  const hourPart = clock.written.match(/^(\d{1,2})/)?.[1];
  return !(hourPart && hourPart.length >= 2 && hourPart.startsWith('0'));
}

function offeredKeyForSlot(clock: ClockTime, slotClock: string, allowPmAlt: boolean): string | null {
  if (slotClock === clock.key) return clock.key;
  if (allowPmAlt && clock.ambiguous && clock.hour < 12) {
    const alt = `${String(clock.hour + 12).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
    if (slotClock === alt) return alt;
  }
  return null;
}

/**
 * The slot start matching one named clock, or null when none / only past matches exist.
 *
 * When the customer names a calendar day (`vandaag`, a date, a weekday), only slots on that
 * day are considered — so tomorrow's 01:00 cannot satisfy "vandaag om 01:00".
 */
export function resolveNamedOfferedSlotStart(
  text: string,
  slots: Array<{ start: string }>,
  timezone: string,
  now: Date,
): string | null {
  const clock = singleNamedClockTime(text);
  if (!clock || slots.length === 0) return null;
  const anchored = hasNamedCalendarAnchor(text, timezone, now);
  const { dates, weekdays } = resolveNamedDates(text, timezone, now);
  const candidates = anchored ? filterSlotsByNamedDay(slots, timezone, dates, weekdays) : slots;
  const allowPmAlt = !anchored || allowPmAltFor(clock);
  const nowMs = now.getTime();
  let pastMatch: string | null = null;
  for (const slot of candidates) {
    const dt = DateTime.fromISO(slot.start).setZone(timezone);
    if (!dt.isValid) continue;
    if (offeredKeyForSlot(clock, dt.toFormat('HH:mm'), allowPmAlt) === null) continue;
    const startMs = new Date(slot.start).getTime();
    if (startMs >= nowMs) return slot.start;
    pastMatch = slot.start;
  }
  return pastMatch;
}

export function namesSingleOfferedSlot(
  text: string,
  slots: Array<{ start: string }>,
  timezone: string,
  now: Date,
): boolean {
  const match = resolveNamedOfferedSlotStart(text, slots, timezone, now);
  return !!match && new Date(match).getTime() >= now.getTime();
}

/** The named hour when no future slot on the anchored day matches it. */
export function unofferedSingleNamedSlot(
  text: string,
  slots: Array<{ start: string }>,
  timezone: string,
  now: Date,
): string | null {
  const clock = singleNamedClockTime(text);
  if (!clock || (clock.dotted && clock.ambiguous)) return null;
  if (namesSingleOfferedSlot(text, slots, timezone, now)) return null;
  const anchored = hasNamedCalendarAnchor(text, timezone, now);
  if (!anchored) {
    return unofferedSingleTimeIn(text, localClockTimes(slots, timezone) ?? []);
  }
  return clock.written;
}

/**
 * "16:00 tot 17:00" is ONE appointment said in full. "9:00 tot 17:00" is when the shop is open.
 *
 * Both are two clock times in one sentence, and the difference decides whether a guard may read
 * them. A confirmation's END is nobody's slot start - the day closes at 17:00, so no slot begins
 * there - and judging it replaces a perfectly correct confirmation. An opening-hours range was
 * never an offer either, and collapsing THAT to one reading would hand it to the single-time
 * guard and replace a true statement about the business.
 *
 * THE LENGTH TELLS THEM APART, and it is the one thing already known: a span exactly as long as
 * an offered slot is this appointment, anything else is a range. So the collapse is gated on the
 * appointment lengths this very call offered, and no rule about "spans" is invented.
 *
 * With no offered lengths nothing collapses, which is the behaviour before this existed.
 */
const NAMED_SPAN =
  // The meridiem alternation is `parseClockTimes`' own, deliberately: `a.m.` / `a.m` OR `am`,
  // never `am.` - so a sentence's full stop is left where the author put it.
  /(\d{1,2}[:.]\d{2}\s*(?:[ap]\.m\.?|[ap]m)?)\s*(?:-|–|—|to|tot|t\/m|until|till|à|bis|hasta|até)\s*(\d{1,2}[:.]\d{2}\s*(?:[ap]\.m\.?|[ap]m)?)/gi;

export function collapseAppointmentSpans(text: string, slotLengthsMin: number[]): string {
  if (slotLengthsMin.length === 0) return text;
  const lengths = new Set(slotLengthsMin);
  return text.replace(NAMED_SPAN, (whole: string, from: string, to: string) => {
    const [start] = parseClockTimes(from);
    const [end] = parseClockTimes(to);
    if (!start || !end) return whole;
    // Modulo a day, so a span running past midnight measures as the appointment it is.
    const minutes = (end.hour * 60 + end.minute - (start.hour * 60 + start.minute) + 1440) % 1440;
    // `from` may carry the space the separator sat behind; the sentence keeps its own spacing.
    return lengths.has(minutes) ? from.trimEnd() : whole;
  });
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

const MONTH_NUMBER: Record<string, number> = {
  januari: 1, january: 1, janvier: 1, jan: 1,
  februari: 2, february: 2, fevrier: 2, février: 2, feb: 2,
  maart: 3, march: 3, mars: 3, mrt: 3, mar: 3,
  april: 4, avril: 4, apr: 4,
  mei: 5, may: 5, mai: 5,
  juni: 6, june: 6, juin: 6, jun: 6,
  juli: 7, july: 7, juillet: 7, jul: 7,
  augustus: 8, august: 8, aout: 8, août: 8, aug: 8,
  september: 9, septembre: 9, sep: 9, sept: 9,
  oktober: 10, october: 10, octobre: 10, okt: 10, oct: 10,
  november: 11, novembre: 11, nov: 11,
  december: 12, décembre: 12, decembre: 12, dec: 12,
};

const MONTH_ALT = Object.keys(MONTH_NUMBER)
  .sort((a, b) => b.length - a.length)
  .join('|');

const WEEKDAY_NUMBER: Record<string, number> = {
  maandag: 1, monday: 1, lundi: 1,
  dinsdag: 2, tuesday: 2, mardi: 2,
  woensdag: 3, wednesday: 3, mercredi: 3,
  donderdag: 4, thursday: 4, jeudi: 4,
  vrijdag: 5, friday: 5, vendredi: 5,
  zaterdag: 6, saturday: 6, samedi: 6,
  zondag: 7, sunday: 7, dimanche: 7,
};

const WEEKDAY_ALT = Object.keys(WEEKDAY_NUMBER)
  .sort((a, b) => b.length - a.length)
  .join('|');

const DAY_MONTH = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_ALT})(?:\\s+(\\d{4}))?\\b`, 'gi');
const MONTH_DAY = new RegExp(`\\b(${MONTH_ALT})\\s+(\\d{1,2})(?:\\s*,\\s*|\\s+)(\\d{4})?\\b`, 'gi');
const NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const WEEKDAY = new RegExp(`\\b(${WEEKDAY_ALT})\\b`, 'gi');

function pushDate(out: string[], year: number, month: number, day: number): void {
  const dt = DateTime.fromObject({ year, month, day });
  if (dt.isValid) out.push(dt.toFormat('yyyy-MM-dd'));
}

/**
 * Whether `text` names this pending start by clock plus a date or weekday.
 *
 * Clock-only is not enough. If the text names any calendar date, every named
 * date must be the pending day. If it names any weekday, every named weekday
 * must be the pending weekday. That splits "2 november om 10:00" from a
 * 26 October pending, and still accepts "donderdag om 13:00".
 */
export function namesPendingDateAndClock(text: string, startTime: string): boolean {
  const pending = DateTime.fromISO(startTime);
  if (!pending.isValid) return false;
  const wantClock = pending.toFormat('HH:mm');
  const wantDate = pending.toFormat('yyyy-MM-dd');
  const wantWeekday = pending.weekday;
  if (!parseClockTimes(text.replace(/\b(\d{1,2})[uh](\d{2})\b/gi, '$1:$2')).some((t) => t.key === wantClock)) return false;
  const dates = parseCalendarDates(text, pending.year);
  const weekdays = parseWeekdays(text);
  if (dates.length === 0 && weekdays.length === 0) return false;
  if (dates.some((d) => d !== wantDate)) return false;
  if (weekdays.some((d) => d !== wantWeekday)) return false;
  return true;
}

/** Calendar days named in `text` as `YYYY-MM-DD`, year defaulting to `fallbackYear`. */
export function parseCalendarDates(text: string, fallbackYear: number): string[] {
  const out: string[] = [];
  ISO_DATE.lastIndex = 0;
  for (const m of text.matchAll(ISO_DATE)) {
    pushDate(out, Number(m[1]), Number(m[2]), Number(m[3]));
  }
  DAY_MONTH.lastIndex = 0;
  for (const m of text.matchAll(DAY_MONTH)) {
    pushDate(out, m[3] ? Number(m[3]) : fallbackYear, MONTH_NUMBER[m[2].toLowerCase()], Number(m[1]));
  }
  MONTH_DAY.lastIndex = 0;
  for (const m of text.matchAll(MONTH_DAY)) {
    pushDate(out, m[3] ? Number(m[3]) : fallbackYear, MONTH_NUMBER[m[1].toLowerCase()], Number(m[2]));
  }
  NUMERIC_DATE.lastIndex = 0;
  for (const m of text.matchAll(NUMERIC_DATE)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : fallbackYear;
    if (b > 12) pushDate(out, year, a, b);
    else pushDate(out, year, b, a);
  }
  return out;
}

/** ISO weekdays (1=Monday) named in `text`. */
export function parseWeekdays(text: string): number[] {
  const out: number[] = [];
  WEEKDAY.lastIndex = 0;
  for (const m of text.matchAll(WEEKDAY)) {
    out.push(WEEKDAY_NUMBER[m[1].toLowerCase()]);
  }
  return out;
}

