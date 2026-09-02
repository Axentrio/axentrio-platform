import { describe, it, expect } from 'vitest';
import { slotsInClockWindow } from '../../booking/booking-providers/booking-dates';

const brussels = [
  { start: '2026-06-10T07:00:00.000Z' }, // 09:00 Europe/Brussels
  { start: '2026-06-10T10:00:00.000Z' }, // 12:00
  { start: '2026-06-10T15:30:00.000Z' }, // 17:30
];

describe('slotsInClockWindow', () => {
  it('keeps afternoon starts in Brussels', () => {
    expect(
      slotsInClockWindow(brussels, { from: '12:00', to: '24:00' }, 'Europe/Brussels').map((s) => s.start),
    ).toEqual(['2026-06-10T10:00:00.000Z', '2026-06-10T15:30:00.000Z']);
  });

  it('keeps morning starts in Brussels', () => {
    expect(
      slotsInClockWindow(brussels, { from: '00:00', to: '12:00' }, 'Europe/Brussels').map((s) => s.start),
    ).toEqual(['2026-06-10T07:00:00.000Z']);
  });

  it('reads a New York DST noon as 12:00 local', () => {
    const slots = [{ start: '2026-06-10T16:00:00.000Z' }];
    expect(slotsInClockWindow(slots, { from: '12:00', to: '13:00' }, 'America/New_York')).toEqual(slots);
  });
});
