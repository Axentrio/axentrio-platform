/**
 * H2 regression — date-only availability ranges must be anchored to the business
 * timezone's calendar day, not the UTC day. The old `new Date("2026-06-08")`
 * (UTC midnight) offset the window by the zone's UTC offset, so the slot engine
 * clipped real evening slots (negative-offset zones) and leaked next-day slots
 * (positive-offset zones), drifting with DST.
 */
import { describe, it, expect } from 'vitest';
import { normalizeDateRange } from '../../booking/booking-providers/internal.provider';

describe('normalizeDateRange', () => {
  it('anchors a date-only day to a positive-offset business tz (Brussels +2)', () => {
    expect(normalizeDateRange('2026-06-08', '2026-06-08', 'Europe/Brussels')).toEqual({
      rangeStart: '2026-06-07T22:00:00.000Z',
      rangeEnd: '2026-06-08T22:00:00.000Z',
    });
  });

  it('anchors a date-only day to a negative-offset business tz (New York EDT -4)', () => {
    expect(normalizeDateRange('2026-06-08', '2026-06-08', 'America/New_York')).toEqual({
      rangeStart: '2026-06-08T04:00:00.000Z',
      rangeEnd: '2026-06-09T04:00:00.000Z',
    });
  });

  it('keeps a UTC business tz at the UTC calendar day', () => {
    expect(normalizeDateRange('2026-06-08', '2026-06-08', 'UTC')).toEqual({
      rangeStart: '2026-06-08T00:00:00.000Z',
      rangeEnd: '2026-06-09T00:00:00.000Z',
    });
  });

  it('a 20:00-local slot falls inside its own day window (the slot the old bug dropped)', () => {
    const { rangeStart, rangeEnd } = normalizeDateRange('2026-06-08', '2026-06-08', 'America/New_York');
    const eightPmEdt = Date.parse('2026-06-09T00:00:00Z'); // 20:00 EDT on 06-08
    expect(eightPmEdt).toBeGreaterThanOrEqual(Date.parse(rangeStart));
    expect(eightPmEdt).toBeLessThan(Date.parse(rangeEnd));
  });

  it('extends a date-only end to include the whole final local day', () => {
    expect(normalizeDateRange('2026-06-08', '2026-06-10', 'Europe/Brussels')).toEqual({
      rangeStart: '2026-06-07T22:00:00.000Z',
      rangeEnd: '2026-06-10T22:00:00.000Z',
    });
  });

  it('respects an explicit-offset datetime instead of re-anchoring it', () => {
    expect(normalizeDateRange('2026-06-08T14:00:00Z', '2026-06-08T15:00:00Z', 'America/New_York')).toEqual({
      rangeStart: '2026-06-08T14:00:00.000Z',
      rangeEnd: '2026-06-08T15:00:00.000Z',
    });
  });

  it('collapses a zero/negative window to a single day', () => {
    const r = normalizeDateRange('2026-06-08', '2026-06-08', 'UTC');
    expect(Date.parse(r.rangeEnd) - Date.parse(r.rangeStart)).toBe(24 * 3600_000);
  });

  it('throws INVALID_RANGE on an unparseable start', () => {
    expect(() => normalizeDateRange('not-a-date', '2026-06-08', 'UTC')).toThrow(/Invalid start date/);
  });
});
