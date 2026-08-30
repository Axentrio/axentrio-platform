import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  clockSelectLabel,
  formatClockRange,
  formatClockTime,
  luxonBookingDisplayFormat,
  luxonChipTitleFormat,
  luxonTimeFormat,
  usesHour12,
} from '../../contracts/clock-format';
import { formatBookingDisplayTime } from '../../booking/booking-providers/booking-dates';

describe('usesHour12', () => {
  it.each([
    'Europe/Brussels',
    'Europe/Amsterdam',
    'Europe/Paris',
    'Europe/London',
    'Europe/Dublin',
    'America/Sao_Paulo',
    'Asia/Tokyo',
    'Africa/Cairo',
  ])('uses 24-hour in %s', (tz) => {
    expect(usesHour12(tz)).toBe(false);
  });

  it.each([
    'America/New_York',
    'US/Eastern',
    'America/Toronto',
    'America/Vancouver',
    'Australia/Sydney',
    'Pacific/Auckland',
    'Pacific/Honolulu',
    'Asia/Manila',
    'Asia/Kolkata',
    'Asia/Karachi',
    'Asia/Dhaka',
    'Asia/Kuala_Lumpur',
  ])('uses 12-hour in %s', (tz) => {
    expect(usesHour12(tz)).toBe(true);
  });

  it('treats a missing or invalid zone as 24-hour', () => {
    expect(usesHour12(undefined)).toBe(false);
    expect(usesHour12('')).toBe(false);
    expect(usesHour12('Not/A_Zone')).toBe(false);
  });
});

describe('clock labels', () => {
  it('keeps HH:mm for Europe and expands AM/PM for the US', () => {
    expect(clockSelectLabel('09:00', 'Europe/Brussels')).toBe('09:00');
    expect(clockSelectLabel('14:30', 'Europe/Brussels')).toBe('14:30');
    expect(clockSelectLabel('00:00', 'America/New_York')).toBe('12:00 AM');
    expect(clockSelectLabel('09:00', 'America/New_York')).toBe('9:00 AM');
    expect(clockSelectLabel('12:00', 'America/New_York')).toBe('12:00 PM');
    expect(clockSelectLabel('14:30', 'America/New_York')).toBe('2:30 PM');
    expect(formatClockRange('09:00', '17:00', 'Europe/Brussels')).toBe('09:00–17:00');
    expect(formatClockRange('09:00', '17:00', 'America/New_York')).toBe('9:00 AM–5:00 PM');
    expect(clockSelectLabel('24:00', 'Europe/Brussels')).toBe('24:00');
    expect(clockSelectLabel('24:00', 'America/New_York')).toBe('12:00 AM (end of day)');
    expect(formatClockRange('00:00', '24:00', 'Europe/Brussels')).toBe('00:00–24:00');
    expect(formatClockRange('00:00', '24:00', 'America/New_York')).toBe(
      '12:00 AM–12:00 AM (end of day)',
    );
  });

  it('picks Luxon tokens from the timezone', () => {
    expect(luxonTimeFormat('Europe/Brussels')).toBe('HH:mm');
    expect(luxonTimeFormat('America/New_York')).toBe('h:mm a');
    expect(luxonChipTitleFormat('Europe/Amsterdam')).toBe('ccc HH:mm');
    expect(luxonChipTitleFormat('America/New_York')).toBe('ccc h:mm a');
  });
});

describe('formatBookingDisplayTime', () => {
  // 12:00Z on 23 June 2026 is 14:00 in Brussels (CEST) and 08:00 in New York (EDT).
  const noonUtc = new Date('2026-06-23T12:00:00.000Z');

  it('names 14:00 in Europe/Brussels, never PM', () => {
    expect(formatBookingDisplayTime(noonUtc, 'Europe/Brussels')).toBe(
      'Tuesday, 23 June 2026 at 14:00',
    );
    expect(luxonBookingDisplayFormat('Europe/Brussels')).toBe("cccc, d LLLL yyyy 'at' HH:mm");
  });

  it('names 8:00 AM in America/New_York', () => {
    expect(formatBookingDisplayTime(noonUtc, 'America/New_York')).toBe(
      'Tuesday, 23 June 2026 at 8:00 AM',
    );
  });
});

describe('formatClockTime / chip title', () => {
  const slot = '2026-04-07T07:00:00.000Z'; // 09:00 Europe/Amsterdam (CEST)

  it('renders a European slot in 24-hour', () => {
    expect(formatClockTime(slot, 'Europe/Amsterdam')).toMatch(/09:00/);
    expect(formatClockTime(slot, 'Europe/Amsterdam')).not.toMatch(/AM|PM/i);
    expect(
      DateTime.fromISO(slot).setZone('Europe/Amsterdam').toFormat(luxonChipTitleFormat('Europe/Amsterdam')),
    ).toBe('Tue 09:00');
  });

  it('renders a US slot with AM/PM', () => {
    expect(
      DateTime.fromISO(slot).setZone('America/New_York').toFormat(luxonChipTitleFormat('America/New_York')),
    ).toBe('Tue 3:00 AM');
  });
});
