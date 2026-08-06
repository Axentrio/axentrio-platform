/**
 * Multi-day closures.
 *
 * A date override could only ever be ONE date. A hairdresser shutting for two weeks in
 * August had to add fourteen rows by hand — and because only the first eight upcoming
 * closures are ever stated to the bot, from day nine it went back to quoting the weekly
 * hours and telling customers their preferred time would be confirmed for a day the
 * business was shut. The fix has to hold in three places at once: the engine that offers
 * slots, the prompt that answers "are you open on the 12th?", and the schema between them.
 */
import { describe, it, expect } from 'vitest';
import { computeSlots } from '../../booking/booking-providers/slot-engine';
import { overrideCoversDate } from '../../database/entities/AvailabilityRule';
import { buildHoursSection } from '../../modules/booking.module';
import { dateOverride, updateSchedulerSchema } from '../../schemas/scheduler.schema';
// The pure module, not booking.service — that edge drags the whole booking graph into a
// unit test and has already made unrelated suites flake once.
import { buildIntakeAnswers } from '../../booking/intake-answers';
import { calendarSyncState } from '../../booking/booking.service';

const RULE = {
  timezone: 'Europe/Brussels',
  availabilityMode: 'business_hours' as const,
  weeklyHours: {
    mon: [{ start: '09:00', end: '17:00' }],
    tue: [{ start: '09:00', end: '17:00' }],
    wed: [{ start: '09:00', end: '17:00' }],
    thu: [{ start: '09:00', end: '17:00' }],
    fri: [{ start: '09:00', end: '17:00' }],
  },
  dateOverrides: [] as unknown[],
  slotGranularityMin: 60,
};
const SERVICE = { durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxHorizonDays: 60 };

/** Slots across a working week, Mon 2026-08-10 → Fri 2026-08-14. */
const slotsForWeek = (dateOverrides: unknown[]) =>
  computeSlots({
    rule: { ...RULE, dateOverrides },
    eventType: SERVICE,
    rangeStart: '2026-08-10T00:00:00Z',
    rangeEnd: '2026-08-15T00:00:00Z',
    now: new Date('2026-08-09T00:00:00Z'),
  } as never);

describe('overrideCoversDate', () => {
  it('covers every day of an inclusive range', () => {
    const o = { date: '2026-08-10', endDate: '2026-08-14', closed: true };
    for (const d of ['2026-08-10', '2026-08-11', '2026-08-14']) {
      expect(overrideCoversDate(o, d)).toBe(true);
    }
    expect(overrideCoversDate(o, '2026-08-09')).toBe(false);
    expect(overrideCoversDate(o, '2026-08-15')).toBe(false);
  });

  it('is a single day when there is no end date', () => {
    const o = { date: '2026-08-10', closed: true };
    expect(overrideCoversDate(o, '2026-08-10')).toBe(true);
    expect(overrideCoversDate(o, '2026-08-11')).toBe(false);
  });

  it('treats a malformed end date as a single day, not an open-ended closure', () => {
    // 'zzz' compares greater than every ISO date, so a permissive check would make one
    // hand-edited row close the business for the rest of time.
    const o = { date: '2026-08-10', endDate: 'zzz' } as never;
    expect(overrideCoversDate(o, '2026-08-10')).toBe(true);
    expect(overrideCoversDate(o, '2026-08-11')).toBe(false);
    expect(overrideCoversDate(o, '2099-01-01')).toBe(false);
  });

  it('degrades a backwards range to a single day rather than covering nothing or everything', () => {
    const o = { date: '2026-08-10', endDate: '2026-08-01', closed: true };
    expect(overrideCoversDate(o, '2026-08-10')).toBe(true);
    expect(overrideCoversDate(o, '2026-08-05')).toBe(false);
  });
});

describe('slot engine — a range closes every day it spans', () => {
  it('offers the full week when nothing is closed', () => {
    expect(slotsForWeek([]).length).toBe(5 * 8);
  });

  it('closes the whole span from ONE row', () => {
    expect(slotsForWeek([{ date: '2026-08-10', endDate: '2026-08-14', closed: true }])).toEqual([]);
  });

  it('closes only the span, not the days either side', () => {
    const out = slotsForWeek([{ date: '2026-08-11', endDate: '2026-08-12', closed: true }]);
    const days = new Set(out.map((s) => s.start.slice(0, 10)));
    expect([...days].sort()).toEqual(['2026-08-10', '2026-08-13', '2026-08-14']);
  });

  it('applies one-off HOURS across a span too, not just closures', () => {
    const out = slotsForWeek([
      { date: '2026-08-11', endDate: '2026-08-12', windows: [{ start: '09:00', end: '11:00' }] },
    ]);
    const byDay = out.filter((s) => s.start.startsWith('2026-08-11') || s.start.startsWith('2026-08-12'));
    expect(byDay).toHaveLength(4); // two hours on each of two days
  });

  it('still honours a plain single-day override', () => {
    const out = slotsForWeek([{ date: '2026-08-12', closed: true }]);
    expect(out.some((s) => s.start.startsWith('2026-08-12'))).toBe(false);
    expect(out.some((s) => s.start.startsWith('2026-08-11'))).toBe(true);
  });
});

describe('prompt — a range is stated as one line and survives its own start', () => {
  const hours = (dateOverrides: unknown[], now: string) =>
    buildHoursSection({ ...RULE, dateOverrides } as never, new Date(now)) ?? '';

  it('renders the span on a single line rather than one line per day', () => {
    const out = hours([{ date: '2026-08-10', endDate: '2026-08-24', closed: true }], '2026-08-01T00:00:00Z');
    expect(out).toContain('2026-08-10 to 2026-08-24');
    expect(out).toContain('CLOSED');
    // Enumerating a fortnight would consume the whole line budget and push later
    // closures out of the prompt entirely — which is the original bug.
    expect(out.split('\n').filter((l) => l.includes('2026-08-1'))).toHaveLength(1);
  });

  it('KEEPS stating a closure that has already begun', () => {
    // The sharp end of the bug: mid-holiday, the bot must still know it is shut.
    const out = hours([{ date: '2026-08-10', endDate: '2026-08-24', closed: true }], '2026-08-18T00:00:00Z');
    expect(out).toContain('2026-08-10 to 2026-08-24');
  });

  it('drops a range only once its LAST day has passed', () => {
    const out = hours([{ date: '2026-08-10', endDate: '2026-08-24', closed: true }], '2026-08-25T00:00:00Z');
    expect(out).not.toContain('2026-08-24');
  });
});

describe('schema', () => {
  it('accepts a range and a bare single date', () => {
    expect(dateOverride.safeParse({ date: '2026-08-10', endDate: '2026-08-24', closed: true }).success).toBe(true);
    expect(dateOverride.safeParse({ date: '2026-08-10', closed: true }).success).toBe(true);
  });

  it('rejects an end date before the start', () => {
    expect(dateOverride.safeParse({ date: '2026-08-10', endDate: '2026-08-01', closed: true }).success).toBe(false);
  });

  it('rejects a span longer than a year — that is a mistake, not a holiday', () => {
    expect(dateOverride.safeParse({ date: '2026-01-01', endDate: '2028-01-01', closed: true }).success).toBe(false);
  });

  it('accepts a range through the real scheduler write path', () => {
    const r = updateSchedulerSchema.safeParse({
      availability: {
        timezone: 'Europe/Brussels',
        weeklyHours: { mon: [{ start: '09:00', end: '17:00' }] },
        dateOverrides: [{ date: '2026-08-10', endDate: '2026-08-24', closed: true }],
      },
    });
    expect(r.success).toBe(true);
  });
});

/**
 * Intake answers on the LEADS surface.
 *
 * The drawer printed the raw question uuid as the field name, so an owner read
 * "a3f2c1d0-1111-…: Second floor" where "Which floor?: Second floor" belonged. The join is
 * done server-side with the SAME builder the bookings surface uses, so the two can never
 * drift — and, importantly, answers whose question has since been deleted survive under
 * their raw key rather than vanishing.
 */
describe('lead intake answers are joined to their labels', () => {
  const QS = [
    { id: 'q1', label: 'Which floor?', type: 'text' as const, required: false },
    { id: 'q2', label: 'Pets at home?', type: 'choice' as const, required: false },
  ];

  it('shows the owner’s question, not the uuid', () => {
    const out = buildIntakeAnswers(QS as never, { q1: 'Second', q2: 'A dog' })!;
    expect(out).toEqual([
      { label: 'Which floor?', answer: 'Second' },
      { label: 'Pets at home?', answer: 'A dog' },
    ]);
  });

  it('keeps an answer whose question was deleted', () => {
    // Losing the customer's words because the owner tidied their question list would be
    // worse than showing a uuid.
    const out = buildIntakeAnswers(QS as never, { q1: 'Second', gone: 'Ring twice' })!;
    expect(out).toContainEqual({ label: 'gone', answer: 'Ring twice' });
  });

  it('survives a hand-edited question list without dropping answers', () => {
    const malformed = [{ id: 42, label: null }, ...QS] as never;
    const out = buildIntakeAnswers(malformed, { q1: 'Second' })!;
    expect(out).toContainEqual({ label: 'Which floor?', answer: 'Second' });
  });

  it('returns null when there is nothing to show', () => {
    expect(buildIntakeAnswers(QS as never, {})).toBeNull();
    expect(buildIntakeAnswers(QS as never, null)).toBeNull();
  });
});

/**
 * The calendar sync pill.
 *
 * `sync_last_error` is written by BOTH the retry path and the terminal path — the difference
 * is that only the terminal path clears `sync_pending` (sync-reconciler: `terminal()` sets it
 * false, `recordFailure()` leaves it true). Testing the error first therefore reported
 * attempt 1 of 6, with the next try due in minutes, as a red "Not on your calendar" alarm
 * telling the owner to reconnect and add the event by hand — while the system was busy
 * fixing it itself.
 */
describe('calendarSync status', () => {
  const sync = (b: Record<string, unknown>, mirrored = false) => calendarSyncState(b as never, mirrored);

  it('reads a RETRYING booking as pending, not failed', () => {
    expect(sync({ status: 'confirmed', syncPending: true, syncLastError: 'ECONNRESET' })).toBe('pending');
  });

  it('reads a genuinely TERMINAL failure as failed', () => {
    // terminal() clears sync_pending, which is what makes it distinguishable at all.
    expect(sync({ status: 'confirmed', syncPending: false, syncLastError: 'no_access' })).toBe('failed');
  });

  it('still reports a healthy mirror as synced', () => {
    expect(sync({ status: 'confirmed', syncPending: false, syncLastError: null }, true)).toBe('synced');
  });

  it('says nothing for a booking that is not confirmed', () => {
    expect(sync({ status: 'request_created', syncPending: true, syncLastError: 'x' })).toBe('none');
  });
});

/**
 * Precedence and reach — the two ways a RANGE was quietly wrong.
 *
 * Ranges made two silent promises nobody had checked: that the row the owner sees as the
 * specific one actually wins, and that a range of one-off HOURS reaches only the days the
 * business was already open. Both failed, and both failed invisibly — the prompt stated one
 * thing while the engine did another, which is the only combination that reaches a customer.
 */
describe('overlapping and ranged overrides', () => {
  /** Mon 2026-08-10 → Fri 2026-08-21, so the span contains Sat 15 and Sun 16. */
  const slotsForFortnight = (dateOverrides: unknown[]) =>
    computeSlots({
      rule: { ...RULE, dateOverrides },
      eventType: SERVICE,
      rangeStart: '2026-08-10T00:00:00Z',
      rangeEnd: '2026-08-22T00:00:00Z',
      now: new Date('2026-08-09T00:00:00Z'),
    } as never);

  const CLOSURE = { date: '2026-08-10', endDate: '2026-08-21', closed: true };
  const REOPEN = { date: '2026-08-14', windows: [{ start: '10:00', end: '14:00' }] };

  it('lets a one-day re-open beat the closure range it sits inside', () => {
    const days = new Set(slotsForFortnight([CLOSURE, REOPEN]).map((s) => s.start.slice(0, 10)));
    expect([...days]).toEqual(['2026-08-14']);
  });

  it('gives the same answer whichever order the owner happened to add the two rows', () => {
    // The portal appends new rows and shows no ordering control, so first-match precedence
    // made the outcome depend on something the owner could neither see nor change.
    const a = slotsForFortnight([CLOSURE, REOPEN]).map((s) => s.start);
    const b = slotsForFortnight([REOPEN, CLOSURE]).map((s) => s.start);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('does not open a weekend that the weekly hours never open', () => {
    // A fortnight of one-off hours is entered with two date pickers and no weekday control.
    // Applying it to every date it spanned opened Sat and Sun, and the create path then
    // confirmed those bookings — computeSlots is what it re-validates against.
    const days = new Set(
      slotsForFortnight([{ date: '2026-08-10', endDate: '2026-08-21', windows: [{ start: '10:00', end: '14:00' }] }])
        .map((s) => s.start.slice(0, 10)),
    );
    expect(days.has('2026-08-15')).toBe(false); // Saturday
    expect(days.has('2026-08-16')).toBe(false); // Sunday
    expect(days.has('2026-08-14')).toBe(true); // Friday, still restated to 10:00–14:00
  });

  it('still opens a single named date the weekly hours never open', () => {
    // The asymmetry is deliberate: naming ONE date is how a one-off Sunday is expressed.
    const days = new Set(
      slotsForFortnight([{ date: '2026-08-16', windows: [{ start: '10:00', end: '14:00' }] }])
        .map((s) => s.start.slice(0, 10)),
    );
    expect(days.has('2026-08-16')).toBe(true);
  });

  it('never states a malformed end date to a customer', () => {
    // The engine shape-checks 'zzz' and ignores the row; the prompt only compared ordering,
    // and 'zzz' sorts above every ISO date — so the bot announced a closure that never ends
    // while the engine kept taking bookings. The two surfaces must agree.
    const rule = { ...RULE, dateOverrides: [{ date: '2026-01-05', endDate: 'zzz', closed: true }] };
    const out = buildHoursSection(rule as never, new Date('2026-08-09T00:00:00Z'));
    expect(out ?? '').not.toMatch(/zzz/);
  });
});
