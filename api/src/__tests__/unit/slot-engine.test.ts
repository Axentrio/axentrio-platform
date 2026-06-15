import { describe, it, expect } from 'vitest';
import { computeSlots, isWithinBusinessHours, SlotEngineInput } from '../../n8n/booking-providers/slot-engine';

// Helper to build an input with sensible defaults.
function input(overrides: Partial<SlotEngineInput> & {
  weeklyHours?: SlotEngineInput['rule']['weeklyHours'];
  dateOverrides?: SlotEngineInput['rule']['dateOverrides'];
  availabilityMode?: SlotEngineInput['rule']['availabilityMode'];
}): SlotEngineInput {
  return {
    rule: {
      timezone: 'Europe/Brussels',
      availabilityMode: overrides.availabilityMode ?? 'business_hours',
      weeklyHours: overrides.weeklyHours ?? {},
      dateOverrides: overrides.dateOverrides ?? [],
      slotGranularityMin: 30,
    },
    eventType: {
      durationMin: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      minNoticeMin: 0,
      maxHorizonDays: 60,
      ...(overrides.eventType ?? {}),
    },
    rangeStart: overrides.rangeStart ?? '2026-06-10T00:00:00Z',
    rangeEnd: overrides.rangeEnd ?? '2026-06-11T00:00:00Z',
    now: overrides.now ?? new Date('2026-06-01T00:00:00Z'),
    busy: overrides.busy,
  };
}

const starts = (slots: { start: string }[]) => slots.map((s) => s.start);

describe('slot-engine · computeSlots', () => {
  // 2026-06-10 is a Wednesday; Brussels is CEST (UTC+2) in June.
  it('produces tz-correct UTC slots for a weekly window', () => {
    const slots = computeSlots(input({ weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] } }));
    expect(starts(slots)).toEqual([
      '2026-06-10T07:00:00.000Z',
      '2026-06-10T07:30:00.000Z',
      '2026-06-10T08:00:00.000Z',
      '2026-06-10T08:30:00.000Z',
    ]);
    expect(slots[0].end).toBe('2026-06-10T07:30:00.000Z');
  });

  it('excludes slots before now + minNotice (and past slots)', () => {
    const slots = computeSlots(
      input({
        weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] },
        now: new Date('2026-06-10T07:10:00Z'),
        eventType: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 60, maxHorizonDays: 60 },
      })
    );
    // earliest start = 08:10Z → only the 08:30Z slot survives.
    expect(starts(slots)).toEqual(['2026-06-10T08:30:00.000Z']);
  });

  it('excludes slots beyond the max horizon', () => {
    const slots = computeSlots(
      input({
        weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] },
        now: new Date('2026-06-01T00:00:00Z'),
        eventType: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxHorizonDays: 5 },
      })
    );
    expect(slots).toEqual([]); // 2026-06-10 is > 5 days past 2026-06-01
  });

  it('treats a closed date override as fully unavailable', () => {
    const slots = computeSlots(
      input({
        weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] },
        dateOverrides: [{ date: '2026-06-10', closed: true }],
      })
    );
    expect(slots).toEqual([]);
  });

  it('replaces weekly hours with override windows for that date', () => {
    const slots = computeSlots(
      input({
        weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] },
        dateOverrides: [{ date: '2026-06-10', windows: [{ start: '14:00', end: '15:00' }] }],
      })
    );
    // 14:00/14:30 Brussels CEST = 12:00Z/12:30Z
    expect(starts(slots)).toEqual(['2026-06-10T12:00:00.000Z', '2026-06-10T12:30:00.000Z']);
  });

  it('subtracts busy intervals', () => {
    const slots = computeSlots(
      input({
        weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] },
        busy: [{ start: new Date('2026-06-10T07:30:00Z'), end: new Date('2026-06-10T08:00:00Z') }],
      })
    );
    // 07:30Z slot overlaps the busy interval; boundary-touching 07:00 and 08:00 do not.
    expect(starts(slots)).toEqual([
      '2026-06-10T07:00:00.000Z',
      '2026-06-10T08:00:00.000Z',
      '2026-06-10T08:30:00.000Z',
    ]);
  });

  it('applies buffers when checking busy overlap', () => {
    const slots = computeSlots(
      input({
        weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] },
        eventType: { durationMin: 30, bufferBeforeMin: 15, bufferAfterMin: 15, minNoticeMin: 0, maxHorizonDays: 60 },
        busy: [{ start: new Date('2026-06-10T08:00:00Z'), end: new Date('2026-06-10T08:15:00Z') }],
      })
    );
    // The 08:00Z slot's after-buffer (→08:45) and the 07:30Z slot's window all
    // interact; 08:00Z (08:00–08:30, blocked±15 = 07:45–08:45) overlaps busy.
    expect(starts(slots)).not.toContain('2026-06-10T08:00:00.000Z');
    expect(starts(slots)).toContain('2026-06-10T07:00:00.000Z');
  });

  it('skips nonexistent local times in the DST spring-forward gap', () => {
    // 2026-03-29 (Sunday) Brussels: 02:00→03:00 gap (CET→CEST).
    const slots = computeSlots(
      input({
        weeklyHours: { sun: [{ start: '01:00', end: '04:00' }] },
        rangeStart: '2026-03-29T00:00:00Z',
        rangeEnd: '2026-03-30T00:00:00Z',
        now: new Date('2026-03-01T00:00:00Z'),
      })
    );
    // 02:00 & 02:30 local don't exist → skipped. 01:00/01:30 CET=00:00Z/00:30Z;
    // 03:00/03:30 CEST=01:00Z/01:30Z.
    expect(starts(slots)).toEqual([
      '2026-03-29T00:00:00.000Z',
      '2026-03-29T00:30:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-29T01:30:00.000Z',
    ]);
  });

  it('always_open ignores empty weekly hours and offers 24/7 slots', () => {
    // Empty weeklyHours would yield zero slots in business_hours mode (the bug).
    const slots = computeSlots(
      input({
        availabilityMode: 'always_open',
        weeklyHours: {},
        rangeStart: '2026-06-10T00:00:00Z',
        rangeEnd: '2026-06-10T02:00:00Z',
      })
    );
    // 00:00–02:00Z window, 30-min granularity, 30-min duration → 4 starts.
    expect(starts(slots)).toEqual([
      '2026-06-10T00:00:00.000Z',
      '2026-06-10T00:30:00.000Z',
      '2026-06-10T01:00:00.000Z',
      '2026-06-10T01:30:00.000Z',
    ]);
  });

  it('always_open still honors a closed date override (holiday)', () => {
    const slots = computeSlots(
      input({
        availabilityMode: 'always_open',
        dateOverrides: [{ date: '2026-06-10', closed: true }],
        // Exactly the Brussels (UTC+2) calendar day 2026-06-10, so only the closed
        // day is in range (a wider UTC range would spill into the open next day).
        rangeStart: '2026-06-09T22:00:00Z',
        rangeEnd: '2026-06-10T22:00:00Z',
      })
    );
    expect(slots).toEqual([]);
  });

  it('uses the first occurrence for ambiguous DST fall-back times', () => {
    // 2026-10-25 (Sunday) Brussels: 03:00→02:00 fall-back; 02:00–03:00 occurs twice.
    const slots = computeSlots(
      input({
        weeklyHours: { sun: [{ start: '02:00', end: '03:00' }] },
        rangeStart: '2026-10-25T00:00:00Z',
        rangeEnd: '2026-10-26T00:00:00Z',
        now: new Date('2026-10-01T00:00:00Z'),
      })
    );
    // First occurrence is CEST (UTC+2): 02:00→00:00Z, 02:30→00:30Z.
    expect(starts(slots)).toEqual(['2026-10-25T00:00:00.000Z', '2026-10-25T00:30:00.000Z']);
  });
});

describe('slot-engine · isWithinBusinessHours', () => {
  const rule = {
    timezone: 'Europe/Brussels',
    availabilityMode: 'business_hours' as const,
    weeklyHours: { wed: [{ start: '09:00', end: '17:00' }] },
    dateOverrides: [],
  };

  // 2026-06-10 is a Wednesday; Brussels is CEST (UTC+2) in June.
  it('classifies inside a weekly window, timezone-aware', () => {
    // 08:00 UTC = 10:00 Brussels — inside 09:00-17:00
    expect(isWithinBusinessHours(rule, new Date('2026-06-10T08:00:00Z'))).toBe(true);
    // 06:30 UTC = 08:30 Brussels — before opening
    expect(isWithinBusinessHours(rule, new Date('2026-06-10T06:30:00Z'))).toBe(false);
    // 15:00 UTC = 17:00 Brussels — end is exclusive
    expect(isWithinBusinessHours(rule, new Date('2026-06-10T15:00:00Z'))).toBe(false);
  });

  it('treats days with no windows as fully after-hours', () => {
    // 2026-06-11 is a Thursday — no thu entry
    expect(isWithinBusinessHours(rule, new Date('2026-06-11T08:00:00Z'))).toBe(false);
  });

  it('honors closed date overrides', () => {
    const closed = { ...rule, dateOverrides: [{ date: '2026-06-10', closed: true }] };
    expect(isWithinBusinessHours(closed, new Date('2026-06-10T08:00:00Z'))).toBe(false);
  });

  it('supports the 24:00 end-of-day marker', () => {
    const lateNight = {
      ...rule,
      weeklyHours: { wed: [{ start: '22:00', end: '24:00' }] },
    };
    // 21:00 UTC = 23:00 Brussels — inside 22:00-24:00
    expect(isWithinBusinessHours(lateNight, new Date('2026-06-10T21:00:00Z'))).toBe(true);
  });

  it('always_open is never after-hours, even with empty weekly hours', () => {
    const open = { ...rule, availabilityMode: 'always_open' as const, weeklyHours: {} };
    // 03:00 UTC on a Thursday (no thu window) — would be after-hours in business mode.
    expect(isWithinBusinessHours(open, new Date('2026-06-11T03:00:00Z'))).toBe(true);
  });

  it('always_open still respects a closed date override', () => {
    const open = {
      ...rule,
      availabilityMode: 'always_open' as const,
      dateOverrides: [{ date: '2026-06-10', closed: true }],
    };
    expect(isWithinBusinessHours(open, new Date('2026-06-10T08:00:00Z'))).toBe(false);
  });
});
