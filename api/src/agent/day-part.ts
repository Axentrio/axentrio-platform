import type { ClockWindow } from '../booking/booking-providers/types';
import { parseClockTimes } from './clock-times';

export const DAY_PART_WINDOWS = {
  morning: { from: '00:00', to: '12:00' },
  afternoon: { from: '12:00', to: '18:00' },
  evening: { from: '17:00', to: '24:00' },
} as const;

const DAY_PART_NEEDLES: Array<{ needles: string[]; window: keyof typeof DAY_PART_WINDOWS }> = [
  { needles: ['voormiddag', 'vroege ochtend'], window: 'morning' },
  { needles: ['namiddag', 'na de middag', 'apres-midi', 'après-midi'], window: 'afternoon' },
  { needles: ['morning', 'ochtend', 'matin'], window: 'morning' },
  { needles: ['afternoon', 'middag', 'middags'], window: 'afternoon' },
  { needles: ['evening', 'avond', 'soir'], window: 'evening' },
];

/** Turn words like "namiddag" into a clock window. First needle match wins. */
export function dayPartWindow(text: string): ClockWindow | null {
  const lower = text.toLowerCase();
  for (const { needles, window } of DAY_PART_NEEDLES) {
    if (needles.some((needle) => lower.includes(needle))) {
      return { ...DAY_PART_WINDOWS[window] };
    }
  }
  return null;
}

/**
 * A window the customer named as a part of day, not as one clock time.
 *
 * Unmatched day-part windows must not draw morning chips for "namiddag". A 30-minute
 * probe around 08:30 is not a day part: that miss should still offer the rest of the day.
 */
export function isDayPartClockWindow(w: ClockWindow): boolean {
  if (Object.values(DAY_PART_WINDOWS).some((d) => d.from === w.from && d.to === w.to)) return true;
  // Schema: afternoon = earliestTime "12:00" with latest omitted → 12:00–24:00.
  return w.from === '12:00' && w.to === '24:00';
}

/**
 * They named one clock, not a day part. A model-passed morning window must not
 * hide the rest of a day that opens at 12:00.
 */
export function namedExactClock(text: string): boolean {
  if (!text || dayPartWindow(text)) return false;
  return new Set(parseClockTimes(text).map((t) => t.key)).size === 1;
}

/** Walk recent customer texts newest-first; a named clock time cancels a day-part preference. */
export function inferDayPartWindow(customerTextsNewestFirst: string[]): ClockWindow | null {
  for (const text of customerTextsNewestFirst.slice(0, 8)) {
    if (parseClockTimes(text).length > 0) return null;
    const window = dayPartWindow(text);
    if (window) return window;
  }
  return null;
}
