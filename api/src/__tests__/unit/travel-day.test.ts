/**
 * The day boundary start-from-base departs at.
 *
 * The rule this file exists to protect is that the departure instant comes from the day's
 * EFFECTIVE windows and never from the weekly grid. `dateOverrides` replace a day's hours,
 * close a day the pattern opens, and open one it does not — so a second derivation reading
 * `weeklyHours` alone would take an earlier opening than the day really has and falsely clear
 * a first job nobody can reach.
 */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { dayOpeningInstant, localDayBounds, type DayRule } from '../../booking/travel/travel-day';

const BRUSSELS_TZ = 'Europe/Brussels';

const rule = (over: Partial<DayRule> = {}): DayRule =>
  ({
    timezone: BRUSSELS_TZ,
    availabilityMode: 'weekly_hours',
    weeklyHours: {
      mon: [{ start: '09:00', end: '17:00' }],
      tue: [{ start: '09:00', end: '17:00' }],
      wed: [{ start: '09:00', end: '17:00' }],
      thu: [{ start: '09:00', end: '17:00' }],
      fri: [{ start: '09:00', end: '17:00' }],
      sat: [],
      sun: [],
    },
    dateOverrides: [],
    ...over,
  }) as DayRule;

/** 2026-09-07 is a Monday; 2026-09-12 a Saturday. */
const day = (iso: string) => DateTime.fromISO(iso, { zone: BRUSSELS_TZ }).startOf('day');
const localTime = (d: Date | null) =>
  d ? DateTime.fromJSDate(d).setZone(BRUSSELS_TZ).toFormat('yyyy-MM-dd HH:mm') : null;

describe('dayOpeningInstant', () => {
  it('takes the weekly opening on an ordinary day', () => {
    expect(localTime(dayOpeningInstant(rule(), day('2026-09-07')))).toBe('2026-09-07 09:00');
  });

  it('takes the EARLIEST window when a day is split', () => {
    const split = rule({
      weeklyHours: {
        mon: [{ start: '14:00', end: '18:00' }, { start: '08:00', end: '12:00' }],
      } as DayRule['weeklyHours'],
    });
    expect(localTime(dayOpeningInstant(split, day('2026-09-07')))).toBe('2026-09-07 08:00');
  });

  it('is null on a day the business is shut', () => {
    expect(dayOpeningInstant(rule(), day('2026-09-12'))).toBeNull();
  });

  it('OBEYS a custom-hours override rather than the weekly grid', () => {
    // The defect this guards: reading `weeklyHours` would depart at 09:00 on a day that in
    // fact opens at 11:00, clearing a first job the owner cannot actually reach in time.
    const overridden = rule({
      dateOverrides: [{ date: '2026-09-07', windows: [{ start: '11:00', end: '15:00' }] }] as DayRule['dateOverrides'],
    });
    expect(localTime(dayOpeningInstant(overridden, day('2026-09-07')))).toBe('2026-09-07 11:00');
  });

  it('OPENS a normally-closed day when a one-off override names it', () => {
    // The other half: the weekly grid says Saturday is shut, so a grid-only reading would find
    // no window and suppress the base check entirely on the day it is most needed.
    const sat = rule({
      dateOverrides: [{ date: '2026-09-12', windows: [{ start: '10:00', end: '14:00' }] }] as DayRule['dateOverrides'],
    });
    expect(localTime(dayOpeningInstant(sat, day('2026-09-12')))).toBe('2026-09-12 10:00');
  });

  it('is null on a day an override closes', () => {
    const closed = rule({
      dateOverrides: [{ date: '2026-09-07', closed: true }] as DayRule['dateOverrides'],
    });
    expect(dayOpeningInstant(closed, day('2026-09-07'))).toBeNull();
  });

  it('is null for an always-open business, whatever the windows say', () => {
    // `windowsForDay` answers 00:00-24:00 in this mode, which is not an opening TIME. Taking it
    // as one would gate every first job against a midnight departure and refuse mornings for a
    // business that never closes — so the mode is checked before the windows, not after.
    expect(dayOpeningInstant(rule({ availabilityMode: 'always_open' }), day('2026-09-07'))).toBeNull();
  });
});

describe('localDayBounds', () => {
  it('bounds a day in the business timezone, not UTC', () => {
    // 00:30 UTC is still the previous day in Brussels for part of the year; the owner's day is
    // the one that matters, because their opening hours are written in it.
    const { dayStart, dayEnd } = localDayBounds(rule(), new Date('2026-09-07T10:00:00Z'));
    expect(localTime(dayStart)).toBe('2026-09-07 00:00');
    expect(localTime(dayEnd)).toBe('2026-09-08 00:00');
  });

  it('spans 23 hours across a spring DST boundary', () => {
    // Europe/Brussels loses an hour on 2026-03-29. A fixed 24h offset would put the boundary an
    // hour into the next day, silently, and only for the businesses in that hour.
    const { dayStart, dayEnd } = localDayBounds(rule(), new Date('2026-03-29T12:00:00Z'));
    expect((dayEnd.getTime() - dayStart.getTime()) / 3_600_000).toBe(23);
  });

  it('spans 25 hours across an autumn DST boundary', () => {
    const { dayStart, dayEnd } = localDayBounds(rule(), new Date('2026-10-25T12:00:00Z'));
    expect((dayEnd.getTime() - dayStart.getTime()) / 3_600_000).toBe(25);
  });
});
