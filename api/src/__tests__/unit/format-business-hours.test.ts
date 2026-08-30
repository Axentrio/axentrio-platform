import { describe, it, expect } from 'vitest';
import {
  formatBusinessHoursForPlaceholder,
  isOutsideBusinessHours,
  type BusinessHours,
} from '../../utils/format-business-hours';
import { isWithinBusinessHours } from '../../booking/booking-providers/slot-engine';

// Wednesday 2026-01-14, 10:00 UTC — inside a 09:00-17:00 UTC Wednesday window.
const WED_10_00Z = new Date('2026-01-14T10:00:00Z');

const bh = (over: Partial<BusinessHours> = {}): BusinessHours => ({
  enabled: true,
  // The legacy stored key — kept on old rows, and deliberately IGNORED by the
  // predicate since the server-owned-timezone cutover (PR 1a). Set to a value
  // that would flip several assertions below if it were ever consulted.
  timezone: 'Asia/Kuala_Lumpur',
  schedule: [{ day: 'wednesday', open: '09:00', close: '17:00', closed: false }],
  ...over,
});

describe('isOutsideBusinessHours', () => {
  it('inside the window → false (open)', () => {
    expect(isOutsideBusinessHours(bh(), 'UTC', WED_10_00Z)).toBe(false);
  });

  it('before open → true', () => {
    expect(isOutsideBusinessHours(bh(), 'UTC', new Date('2026-01-14T08:00:00Z'))).toBe(true);
  });

  it('at or after close → true', () => {
    expect(isOutsideBusinessHours(bh(), 'UTC', new Date('2026-01-14T17:00:00Z'))).toBe(true);
    expect(isOutsideBusinessHours(bh(), 'UTC', new Date('2026-01-14T18:00:00Z'))).toBe(true);
  });

  it('the day is explicitly closed → true', () => {
    expect(
      isOutsideBusinessHours(
        bh({ schedule: [{ day: 'wednesday', open: '09:00', close: '17:00', closed: true }] }),
        'UTC',
        WED_10_00Z,
      ),
    ).toBe(true);
  });

  it('no entry for today → true (closed today)', () => {
    expect(
      isOutsideBusinessHours(
        bh({ schedule: [{ day: 'monday', open: '09:00', close: '17:00', closed: false }] }),
        'UTC',
        WED_10_00Z,
      ),
    ).toBe(true);
  });

  it('disabled / empty / null → false (never announce closed when unsure)', () => {
    expect(isOutsideBusinessHours(bh({ enabled: false }), 'UTC', new Date('2026-01-14T08:00:00Z'))).toBe(false);
    expect(isOutsideBusinessHours(bh({ schedule: [] }), 'UTC', new Date('2026-01-14T08:00:00Z'))).toBe(false);
    expect(isOutsideBusinessHours(null, 'UTC', new Date('2026-01-14T08:00:00Z'))).toBe(false);
    expect(isOutsideBusinessHours(undefined, 'UTC', new Date('2026-01-14T08:00:00Z'))).toBe(false);
  });

  it('invalid or missing timezone argument → false (fail safe open)', () => {
    expect(isOutsideBusinessHours(bh(), 'Not/AZone', new Date('2026-01-14T08:00:00Z'))).toBe(false);
    expect(isOutsideBusinessHours(bh(), '', new Date('2026-01-14T08:00:00Z'))).toBe(false);
  });

  it('malformed open/close → false (fail safe open)', () => {
    expect(
      isOutsideBusinessHours(
        bh({ schedule: [{ day: 'wednesday', open: undefined as never, close: undefined as never, closed: false }] }),
        'UTC',
        new Date('2026-01-14T08:00:00Z'),
      ),
    ).toBe(false);
  });

  it('honours the EXPLICIT timezone argument (Brussels is UTC+1 in January)', () => {
    // 08:30 UTC = 09:30 Brussels → inside 09:00-17:00
    expect(isOutsideBusinessHours(bh(), 'Europe/Brussels', new Date('2026-01-14T08:30:00Z'))).toBe(false);
    // 07:30 UTC = 08:30 Brussels → before 09:00 → outside
    expect(isOutsideBusinessHours(bh(), 'Europe/Brussels', new Date('2026-01-14T07:30:00Z'))).toBe(true);
  });

  it('IGNORES the legacy bh.timezone — the argument alone decides (PR 1a)', () => {
    // bh() carries Asia/Kuala_Lumpur (UTC+8). 08:00 UTC = 16:00 KL (inside) but
    // 09:00 Brussels (open boundary). If the stored key were consulted, this
    // would read "open" for the wrong reason at 07:59 UTC and flip nothing at
    // close. Pin both directions against the explicit argument.
    // 07:59 UTC = 08:59 Brussels → outside; 15:59 KL would be inside.
    expect(isOutsideBusinessHours(bh(), 'Europe/Brussels', new Date('2026-01-14T07:59:00Z'))).toBe(true);
    // 16:30 UTC = 17:30 Brussels → outside; 00:30 KL (Thu, no entry) — but the
    // argument, not the stored key, must be what closes it.
    expect(isOutsideBusinessHours(bh(), 'Europe/Brussels', new Date('2026-01-14T16:30:00Z'))).toBe(true);
  });

  describe('DST in Brussels (A4)', () => {
    // Spring forward: Sunday 2026-03-29, 02:00 CET → 03:00 CEST. From that
    // instant Brussels is UTC+2, so a 09:00 open is 07:00 UTC (was 08:00 UTC).
    const dstDay = (day: string) => bh({ schedule: [{ day, open: '09:00', close: '17:00', closed: false }] });

    it('spring-forward day: open boundary follows the NEW offset (UTC+2)', () => {
      // 07:30 UTC on 2026-03-29 = 09:30 CEST → open.
      expect(isOutsideBusinessHours(dstDay('sunday'), 'Europe/Brussels', new Date('2026-03-29T07:30:00Z'))).toBe(false);
      // 06:30 UTC = 08:30 CEST → before open.
      expect(isOutsideBusinessHours(dstDay('sunday'), 'Europe/Brussels', new Date('2026-03-29T06:30:00Z'))).toBe(true);
    });

    it('fall-back day (2026-10-25, 03:00 CEST → 02:00 CET): open boundary follows UTC+1', () => {
      // 08:30 UTC = 09:30 CET → open.
      expect(isOutsideBusinessHours(dstDay('sunday'), 'Europe/Brussels', new Date('2026-10-25T08:30:00Z'))).toBe(false);
      // 07:30 UTC = 08:30 CET → before open. (Under summer time this WAS 09:30.)
      expect(isOutsideBusinessHours(dstDay('sunday'), 'Europe/Brussels', new Date('2026-10-25T07:30:00Z'))).toBe(true);
    });
  });

  describe('Date Overrides (closed days / one-off hours)', () => {
    it('a closed date is outside hours even when the weekly grid is open', () => {
      expect(
        isOutsideBusinessHours(
          bh({
            dateOverrides: [{ date: '2026-01-14', closed: true }],
          }),
          'UTC',
          WED_10_00Z,
        ),
      ).toBe(true);
    });

    it('override hours replace the weekly window for that date', () => {
      const short = bh({
        dateOverrides: [{ date: '2026-01-14', windows: [{ start: '12:00', end: '14:00' }] }],
      });
      // 10:00 UTC is inside the weekly 09–17, but outside the 12–14 override.
      expect(isOutsideBusinessHours(short, 'UTC', WED_10_00Z)).toBe(true);
      expect(isOutsideBusinessHours(short, 'UTC', new Date('2026-01-14T13:00:00Z'))).toBe(false);
      expect(isOutsideBusinessHours(short, 'UTC', new Date('2026-01-14T14:00:00Z'))).toBe(true);
    });

    it('a date with no override falls back to the weekly schedule', () => {
      expect(
        isOutsideBusinessHours(
          bh({
            dateOverrides: [{ date: '2026-01-15', closed: true }],
          }),
          'UTC',
          WED_10_00Z,
        ),
      ).toBe(false);
    });

    it('a malformed or empty exception fails safe to open', () => {
      // Closed flag absent, windows unusable → never announce closed.
      expect(
        isOutsideBusinessHours(
          bh({
            dateOverrides: [{ date: '2026-01-14', windows: [{ start: '', end: '' }] }],
          }),
          'UTC',
          new Date('2026-01-14T08:00:00Z'),
        ),
      ).toBe(false);
      expect(
        isOutsideBusinessHours(
          bh({
            dateOverrides: [{ date: '2026-01-14' }],
          }),
          'UTC',
          new Date('2026-01-14T08:00:00Z'),
        ),
      ).toBe(false);
    });

    it('a multi-day closed range covers every date it spans', () => {
      const range = bh({
        dateOverrides: [{ date: '2026-01-13', endDate: '2026-01-16', closed: true }],
      });
      expect(isOutsideBusinessHours(range, 'UTC', WED_10_00Z)).toBe(true);
    });
  });

  describe('operational hours agree with booking hours on the same local instant (A4)', () => {
    // The SAME Wednesday 09:00–17:00 schedule expressed both ways, both read in
    // the one canonical business timezone. If the off-hours gate and the slot
    // engine ever disagreed about "now", the pilot bug returns: the bot refuses
    // chat while offering slots, or vice versa.
    const rule = {
      timezone: 'Europe/Brussels',
      availabilityMode: 'business_hours' as const,
      weeklyHours: { wed: [{ start: '09:00', end: '17:00' }] },
      dateOverrides: [],
    };
    const operational = bh(); // wednesday 09:00-17:00 (legacy tz key ignored)

    const instants = [
      new Date('2026-01-14T07:59:00Z'), // 08:59 Brussels — before open
      new Date('2026-01-14T08:00:00Z'), // 09:00 Brussels — open boundary
      new Date('2026-01-14T12:00:00Z'), // 13:00 Brussels — middle of day
      new Date('2026-01-14T15:59:00Z'), // 16:59 Brussels — last open minute
      new Date('2026-01-14T16:00:00Z'), // 17:00 Brussels — close boundary
    ];

    it.each(instants.map((d) => [d.toISOString(), d] as const))('%s', (_label, instant) => {
      const bookingOpen = isWithinBusinessHours(rule, instant);
      const operationalOpen = !isOutsideBusinessHours(operational, 'Europe/Brussels', instant);
      expect(operationalOpen).toBe(bookingOpen);
    });

    it('a shared closed Date Override keeps the two predicates in lockstep', () => {
      const closed = [{ date: '2026-01-14', closed: true }];
      const bookingOpen = isWithinBusinessHours({ ...rule, dateOverrides: closed }, WED_10_00Z);
      const operationalOpen = !isOutsideBusinessHours(
        bh({ dateOverrides: closed }),
        'Europe/Brussels',
        WED_10_00Z,
      );
      expect(operationalOpen).toBe(false);
      expect(operationalOpen).toBe(bookingOpen);
    });
  });
});

describe('formatBusinessHoursForPlaceholder — closed weekdays and one-off hours', () => {
  it('names a closed Wednesday so yesterday can bind', () => {
    const hours = bh({
      schedule: [
        { day: 'monday', open: '09:00', close: '17:00', closed: false },
        { day: 'wednesday', open: '', close: '', closed: true },
        { day: 'thursday', open: '09:00', close: '17:00', closed: false },
      ],
    });
    expect(formatBusinessHoursForPlaceholder(hours)).toContain('Wed closed');
    expect(formatBusinessHoursForPlaceholder(hours)).toContain('Mon 09:00–17:00');
    expect(formatBusinessHoursForPlaceholder(hours, WED_10_00Z, 'America/New_York')).toContain(
      'Mon 9:00 AM–5:00 PM',
    );
  });

  it('states one-off hours that open a normally-closed Sunday', () => {
    const hours = bh({
      schedule: [
        { day: 'monday', open: '09:00', close: '17:00', closed: false },
        { day: 'sunday', open: '', close: '', closed: true },
      ],
      dateOverrides: [{ date: '2026-10-04', closed: false, windows: [{ start: '09:00', end: '16:00' }] }],
    });
    const out = formatBusinessHoursForPlaceholder(hours, new Date('2026-08-20T10:00:00Z'), 'Europe/Brussels');
    expect(out).toContain('Sun closed');
    expect(out).toContain('2026-10-04 open 09:00–16:00');
  });
});

describe('formatBusinessHoursForPlaceholder — timezone-correct closures', () => {
  const hours = {
    enabled: true,
    schedule: [{ day: 'monday', open: '09:00', close: '17:00', closed: false }],
    dateOverrides: [{ date: '2026-08-22', closed: true }],
  } as BusinessHours;
  // 04:00 UTC on 23 Aug is still 21:00 on 22 Aug in Los Angeles. Computing "today"
  // in UTC would drop a closure the business is still inside of.
  const afterMidnightUtc = new Date('2026-08-23T04:00:00Z');

  it('keeps a still-current local closed date when UTC has already rolled over', () => {
    expect(formatBusinessHoursForPlaceholder(hours, afterMidnightUtc, 'America/Los_Angeles')).toContain(
      'closed 2026-08-22',
    );
  });

  it('drops that date once "today" in UTC has already passed it', () => {
    expect(formatBusinessHoursForPlaceholder(hours, afterMidnightUtc, 'UTC')).not.toContain('2026-08-22');
  });
});
