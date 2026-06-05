import { describe, it, expect } from 'vitest';
import { computeSlots, SlotEngineInput } from '../../n8n/booking-providers/slot-engine';

// Helper to build an input with sensible defaults.
function input(overrides: Partial<SlotEngineInput> & {
  weeklyHours?: SlotEngineInput['rule']['weeklyHours'];
  dateOverrides?: SlotEngineInput['rule']['dateOverrides'];
}): SlotEngineInput {
  return {
    rule: {
      timezone: 'Europe/Brussels',
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
