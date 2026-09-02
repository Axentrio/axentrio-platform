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

/** Walk recent customer texts newest-first; a named clock time cancels a day-part preference. */
export function inferDayPartWindow(customerTextsNewestFirst: string[]): ClockWindow | null {
  for (const text of customerTextsNewestFirst.slice(0, 8)) {
    if (parseClockTimes(text).length > 0) return null;
    const window = dayPartWindow(text);
    if (window) return window;
  }
  return null;
}
