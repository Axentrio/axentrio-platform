import { describe, it, expect } from 'vitest';
import { computeSlots, type BusyInterval } from '../../booking/booking-providers/slot-engine';
import { bookingRulesSchema, updateSchedulerSchema } from '../../schemas/scheduler.schema';

/** Wed 2026-06-10, 09:00–17:00 Brussels. */
const RULE = {
  timezone: 'Europe/Brussels',
  availabilityMode: 'business_hours' as const,
  weeklyHours: { wed: [{ start: '09:00', end: '17:00' }] },
  dateOverrides: [],
  slotGranularityMin: 60,
};
const SERVICE = {
  durationMin: 60,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 0,
  maxHorizonDays: 60,
};
const NOW = new Date('2026-06-09T00:00:00Z');
const DAY_START = '2026-06-10T00:00:00Z';
const DAY_END = '2026-06-11T00:00:00Z';

const slots = (extra: Record<string, unknown> = {}) =>
  computeSlots({
    rule: RULE,
    eventType: SERVICE,
    rangeStart: DAY_START,
    rangeEnd: DAY_END,
    now: NOW,
    ...extra,
  } as never);

/** n one-hour bookings on the target day, at their RAW bounds. */
const ledgerOf = (n: number, durationMin = 60): BusyInterval[] =>
  Array.from({ length: n }, (_, i) => ({
    start: new Date(Date.UTC(2026, 5, 10, 7 + i, 0)),
    end: new Date(Date.UTC(2026, 5, 10, 7 + i, 0) + durationMin * 60_000),
  }));

describe('slot engine — business day ceilings', () => {
  it('offers the full day when no business rules are set', () => {
    expect(slots().length).toBe(8); // 09:00–17:00, hourly
  });

  it('offers nothing on a day already at the business booking cap', () => {
    const out = slots({ business: { maxBookingsPerDay: 3 }, dayLedger: ledgerOf(3) });
    expect(out).toEqual([]);
  });

  it('still offers a day under the cap', () => {
    const out = slots({ business: { maxBookingsPerDay: 4 }, dayLedger: ledgerOf(3) });
    expect(out.length).toBeGreaterThan(0);
  });

  it('offers nothing once the day has no working time left for this service', () => {
    // 7 hours booked, 7h cap, and this service needs another hour.
    const out = slots({ business: { maxBookedMinutesPerDay: 420 }, dayLedger: ledgerOf(7) });
    expect(out).toEqual([]);
  });

  it('counts MINUTES, not slots — one long job can exhaust the day', () => {
    // A single 7-hour booking against a 7-hour cap leaves no room, even though it is
    // only ONE booking and the count cap is untouched.
    const out = slots({
      business: { maxBookingsPerDay: 10, maxBookedMinutesPerDay: 420 },
      dayLedger: ledgerOf(1, 420),
    });
    expect(out).toEqual([]);
  });

  it('ignores the ledger entirely when neither day cap is set', () => {
    // The gap rule is applied by inflating `busy` in the caller, never from the ledger,
    // so a ledger alone must not suppress anything.
    expect(slots({ business: { minGapMin: 60 }, dayLedger: ledgerOf(8) }).length).toBe(8);
  });

  it('treats null/0 as unlimited rather than as zero', () => {
    expect(slots({ business: { maxBookingsPerDay: null, maxBookedMinutesPerDay: 0 }, dayLedger: ledgerOf(9) }).length).toBe(8);
  });
});

describe('slot engine — minimum gap via busy inflation', () => {
  // The gap is implemented by padding OUR bookings in the caller, so the engine sees it as
  // an ordinary busy interval. These assert the arithmetic the caller relies on.
  const booked = { start: new Date('2026-06-10T09:00:00Z'), end: new Date('2026-06-10T10:00:00Z') };
  const pad = (iv: BusyInterval, min: number) => ({
    start: new Date(iv.start.getTime() - min * 60_000),
    end: new Date(iv.end.getTime() + min * 60_000),
  });

  it('frees the adjacent slot when there is no gap', () => {
    const out = slots({ busy: [booked] });
    expect(out.some((s) => s.start === '2026-06-10T10:00:00.000Z')).toBe(true);
  });

  it('suppresses the adjacent slot once the gap is padded in', () => {
    const out = slots({ busy: [pad(booked, 30)] });
    expect(out.some((s) => s.start === '2026-06-10T10:00:00.000Z')).toBe(false);
    // …but the hour after is still offered — the gap is a gap, not a closure.
    expect(out.some((s) => s.start === '2026-06-10T11:00:00.000Z')).toBe(true);
  });
});

describe('bookingRulesSchema', () => {
  it('accepts a full set and a fully-cleared set', () => {
    expect(bookingRulesSchema.safeParse({ maxBookingsPerDay: 4, maxBookedMinutesPerDay: 420, minGapMin: 30 }).success).toBe(true);
    // null CLEARS a rule; this is how the portal turns a limit off.
    expect(bookingRulesSchema.safeParse({ maxBookingsPerDay: null, maxBookedMinutesPerDay: null, minGapMin: null }).success).toBe(true);
  });

  it('distinguishes an omitted key from an explicit null', () => {
    const r = bookingRulesSchema.parse({ maxBookingsPerDay: null });
    expect('maxBookingsPerDay' in r).toBe(true);
    expect(r.maxBookingsPerDay).toBeNull();
    expect('minGapMin' in r).toBe(false); // untouched, not cleared
  });

  it('rejects nonsense values', () => {
    expect(bookingRulesSchema.safeParse({ maxBookingsPerDay: 0 }).success).toBe(false);
    expect(bookingRulesSchema.safeParse({ maxBookedMinutesPerDay: 5000 }).success).toBe(false);
    expect(bookingRulesSchema.safeParse({ minGapMin: -1 }).success).toBe(false);
    expect(bookingRulesSchema.safeParse({ maxBookingsPerDay: 2.5 }).success).toBe(false);
  });

  it('is a valid standalone scheduler-config write', () => {
    expect(updateSchedulerSchema.safeParse({ bookingRules: { minGapMin: 15 } }).success).toBe(true);
  });
});
