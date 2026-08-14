import { describe, it, expect } from 'vitest';
import { isOutsideBusinessHours, type BusinessHours } from '../../utils/format-business-hours';

// Wednesday 2026-01-14, 10:00 UTC — inside a 09:00-17:00 UTC Wednesday window.
const WED_10_00Z = new Date('2026-01-14T10:00:00Z');

const bh = (over: Partial<BusinessHours> = {}): BusinessHours => ({
  enabled: true,
  timezone: 'UTC',
  schedule: [{ day: 'wednesday', open: '09:00', close: '17:00', closed: false }],
  ...over,
});

describe('isOutsideBusinessHours', () => {
  it('inside the window → false (open)', () => {
    expect(isOutsideBusinessHours(bh(), WED_10_00Z)).toBe(false);
  });

  it('before open → true', () => {
    expect(isOutsideBusinessHours(bh(), new Date('2026-01-14T08:00:00Z'))).toBe(true);
  });

  it('at or after close → true', () => {
    expect(isOutsideBusinessHours(bh(), new Date('2026-01-14T17:00:00Z'))).toBe(true);
    expect(isOutsideBusinessHours(bh(), new Date('2026-01-14T18:00:00Z'))).toBe(true);
  });

  it('the day is explicitly closed → true', () => {
    expect(
      isOutsideBusinessHours(
        bh({ schedule: [{ day: 'wednesday', open: '09:00', close: '17:00', closed: true }] }),
        WED_10_00Z,
      ),
    ).toBe(true);
  });

  it('no entry for today → true (closed today)', () => {
    expect(
      isOutsideBusinessHours(
        bh({ schedule: [{ day: 'monday', open: '09:00', close: '17:00', closed: false }] }),
        WED_10_00Z,
      ),
    ).toBe(true);
  });

  it('disabled / empty / null → false (never announce closed when unsure)', () => {
    expect(isOutsideBusinessHours(bh({ enabled: false }), new Date('2026-01-14T08:00:00Z'))).toBe(false);
    expect(isOutsideBusinessHours(bh({ schedule: [] }), new Date('2026-01-14T08:00:00Z'))).toBe(false);
    expect(isOutsideBusinessHours(null, new Date('2026-01-14T08:00:00Z'))).toBe(false);
    expect(isOutsideBusinessHours(undefined, new Date('2026-01-14T08:00:00Z'))).toBe(false);
  });

  it('invalid timezone → false (fail safe open)', () => {
    expect(
      isOutsideBusinessHours(bh({ timezone: 'Not/AZone' }), new Date('2026-01-14T08:00:00Z')),
    ).toBe(false);
  });

  it('malformed open/close → false (fail safe open)', () => {
    expect(
      isOutsideBusinessHours(
        bh({ schedule: [{ day: 'wednesday', open: undefined as never, close: undefined as never, closed: false }] }),
        new Date('2026-01-14T08:00:00Z'),
      ),
    ).toBe(false);
  });

  it('honours the timezone (Brussels is UTC+1 in January)', () => {
    // 08:30 UTC = 09:30 Brussels → inside 09:00-17:00
    expect(
      isOutsideBusinessHours(bh({ timezone: 'Europe/Brussels' }), new Date('2026-01-14T08:30:00Z')),
    ).toBe(false);
    // 07:30 UTC = 08:30 Brussels → before 09:00 → outside
    expect(
      isOutsideBusinessHours(bh({ timezone: 'Europe/Brussels' }), new Date('2026-01-14T07:30:00Z')),
    ).toBe(true);
  });
});
