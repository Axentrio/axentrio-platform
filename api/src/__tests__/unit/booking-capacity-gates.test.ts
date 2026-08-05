/**
 * The two capacity gates that run INSIDE the advisory-lock transaction.
 *
 * These exist separately from the slot-engine tests for a reason worth remembering: filtering
 * slots is advisory, and the `EXCLUDE USING gist` constraint only understands overlap of
 * `blocked_range`. It cannot see a day count, a minutes budget, or a required gap — so two
 * concurrent bookers both pass slot filtering and both land. Only these SQL gates stop that,
 * and until now they were asserted as SQL SUBSTRINGS against a manager mock that never looked
 * at the parameters. Seven mutations to this file's subject passed the whole booking suite.
 *
 * So: drive them with a fake `EntityManager` that records `(sql, params)` and hands back rows,
 * and assert the VALUES — the window bounds, the padded gap range, the arithmetic — rather
 * than the shape of the query text.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { BookingError } from '../../booking/booking-providers/types';

vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: vi.fn(() => ({})), manager: { getRepository: vi.fn(() => ({})) }, transaction: vi.fn() },
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../integrations/google/google-calendar.service', () => ({
  getGoogleBusyForBot: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  resolveCalendarIdentity: vi.fn(),
}));
vi.mock('../../scheduler/calendar-provider', () => ({
  resolveCalendarProvider: vi.fn(),
  providerFor: vi.fn(),
  isCalendarSyncAllowed: vi.fn(),
  resolveStoredCalendarIdentity: vi.fn(),
  hasHealthyCalendarConnection: vi.fn(),
}));
vi.mock('../../booking/booking-providers/booking-email', () => ({
  sendBookingEmail: vi.fn(),
  sendRequestNotificationEmail: vi.fn(),
}));
vi.mock('../../file-handling/upload.service', () => ({ getUploadService: () => ({}) }));
vi.mock('../../webhooks/webhook.emitter', () => ({ emitWebhookEvent: vi.fn(), buildEventBase: vi.fn() }));

import {
  enforceServiceDayCapacity,
  enforceBusinessCapacity,
  normalizeIntakeAnswers,
} from '../../booking/booking-providers/internal.provider';
import type { BusinessRules } from '../../booking/booking-providers/service-timing';
import { EMPTY_VENUE } from '../../contracts/venue-address';

/** Records every statement and replays canned rows in order. */
function fakeManager(...responses: unknown[][]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const manager = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return responses[i++] ?? [];
    },
  } as unknown as EntityManager;
  return { manager, calls };
}

const TZ = 'Europe/Brussels';
const svc = (over: Record<string, unknown> = {}) =>
  ({ id: 'svc-1', maxBookingsPerDay: 3, ...over }) as never;

const rules = (over: Partial<BusinessRules> = {}): BusinessRules => ({
  maxBookingsPerDay: 0,
  maxBookedMinutesPerDay: 0,
  minGapMin: 0,
  defaultBufferBeforeMin: null,
  defaultBufferAfterMin: null,
  defaultMinNoticeMin: null,
  defaultMaxHorizonDays: null,
  venue: EMPTY_VENUE,
  bookingsPaused: false,
  ...over,
});

/** A 60-minute job at 10:00 Brussels on an ordinary Wednesday. */
const window60 = {
  start: new Date('2026-06-10T08:00:00Z'),
  end: new Date('2026-06-10T09:00:00Z'),
  blockedStart: new Date('2026-06-10T08:00:00Z'),
  blockedEnd: new Date('2026-06-10T09:00:00Z'),
};

const hours = (a: unknown, b: unknown) =>
  (Date.parse(b as string) - Date.parse(a as string)) / 3_600_000;

async function reason(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'did not throw';
  } catch (e) {
    return e instanceof BookingError ? `${e.code}:${e.message}` : `unexpected:${String(e)}`;
  }
}

describe('enforceServiceDayCapacity', () => {
  it('never queries at all when the service has no cap', async () => {
    for (const max of [null, undefined, 0, -1]) {
      const { manager, calls } = fakeManager();
      await enforceServiceDayCapacity(manager, svc({ maxBookingsPerDay: max }), window60.start, TZ);
      expect(calls).toEqual([]); // a malformed cap must read as unlimited, never as zero
    }
  });

  it('counts the LOCAL calendar day, not the UTC one', async () => {
    // 23:30 Brussels on the 10th is already the 11th in UTC. Counting the UTC day would
    // put this booking on a different day from the one the customer sees.
    const m = fakeManager([{ n: 0 }]);
    await enforceServiceDayCapacity(m.manager, svc(), new Date('2026-06-10T21:30:00Z'), TZ);
    const [, dayStart, nextDay] = m.calls[0].params;
    expect(dayStart).toBe('2026-06-09T22:00:00.000Z'); // 2026-06-10 00:00 Brussels
    expect(nextDay).toBe('2026-06-10T22:00:00.000Z'); // 2026-06-11 00:00 Brussels
  });

  it('keeps the window on real local midnights across a DST transition', async () => {
    // Brussels springs forward on 2026-03-29 and falls back on 2026-10-25. Advancing by a
    // flat 24h lands at 01:00 or 23:00 of the next day, so the gate double-counted or
    // clipped an hour and disagreed with the day ledger.
    const spring = fakeManager([{ n: 0 }]);
    await enforceServiceDayCapacity(spring.manager, svc(), new Date('2026-03-29T10:00:00Z'), TZ);
    const [, sStart, sNext] = spring.calls[0].params;
    expect(hours(sStart, sNext)).toBe(23);

    const autumn = fakeManager([{ n: 0 }]);
    await enforceServiceDayCapacity(autumn.manager, svc(), new Date('2026-10-25T10:00:00Z'), TZ);
    const [, aStart, aNext] = autumn.calls[0].params;
    expect(hours(aStart, aNext)).toBe(25);
  });

  it('rejects at the cap, not one past it', async () => {
    const at = fakeManager([{ n: 3 }]);
    expect(await reason(() => enforceServiceDayCapacity(at.manager, svc(), window60.start, TZ)))
      .toBe('CAPACITY_REACHED:No more openings for this service that day');

    const under = fakeManager([{ n: 2 }]);
    await expect(enforceServiceDayCapacity(under.manager, svc(), window60.start, TZ)).resolves.toBeUndefined();
  });

  it('excludes the booking being moved, so a reschedule does not block on itself', async () => {
    // The count comes back under the cap precisely BECAUSE the row being moved was excluded;
    // asserting the parameter is what proves the exclusion reached the query.
    const m = fakeManager([{ n: 2 }]);
    await enforceServiceDayCapacity(m.manager, svc(), window60.start, TZ, 'bk-9');
    expect(m.calls[0].params[3]).toBe('bk-9');
    expect(m.calls[0].sql).toContain('id <> $4');
  });

  it('scopes to the service and counts only HELD rows', async () => {
    const m = fakeManager([{ n: 0 }]);
    await enforceServiceDayCapacity(m.manager, svc({ id: 'svc-42' }), window60.start, TZ);
    expect(m.calls[0].params[0]).toBe('svc-42');
    // A captured request must not consume the service's day — only accepting one does.
    expect(m.calls[0].sql).toContain(`status IN ('pending','confirmed')`);
  });
});

describe('enforceBusinessCapacity', () => {
  it('never queries when no business rule is set', async () => {
    const { manager, calls } = fakeManager();
    await enforceBusinessCapacity(manager, 'bot-1', rules(), window60, TZ);
    expect(calls).toEqual([]);
  });

  it('rejects at the business day count, across every service', async () => {
    const m = fakeManager([{ n: 4, mins: 240 }]);
    expect(
      await reason(() =>
        enforceBusinessCapacity(m.manager, 'bot-1', rules({ maxBookingsPerDay: 4 }), window60, TZ)
      )
    ).toBe('CAPACITY_REACHED:This business is fully booked that day');
    expect(m.calls[0].params[0]).toBe('bot-1'); // bot-wide, not per service
  });

  it('keeps its own day window on real local midnights across a DST transition', async () => {
    // Asserted separately from the service gate on purpose: the two build the window with
    // duplicated code, so a fix to one leaves the other wrong. Both must be pinned.
    const spring = fakeManager([{ n: 0, mins: 0 }]);
    await enforceBusinessCapacity(
      spring.manager,
      'bot-1',
      rules({ maxBookingsPerDay: 5 }),
      { ...window60, start: new Date('2026-03-29T10:00:00Z') },
      TZ
    );
    expect(hours(spring.calls[0].params[1], spring.calls[0].params[2])).toBe(23);

    const autumn = fakeManager([{ n: 0, mins: 0 }]);
    await enforceBusinessCapacity(
      autumn.manager,
      'bot-1',
      rules({ maxBookingsPerDay: 5 }),
      { ...window60, start: new Date('2026-10-25T10:00:00Z') },
      TZ
    );
    expect(hours(autumn.calls[0].params[1], autumn.calls[0].params[2])).toBe(25);
  });

  it('never lets a captured request consume capacity — in either query', async () => {
    // Capturing a request costs nothing; only ACCEPTING one does. If `request_created` ever
    // joins these status lists, a business fills its own day by receiving enquiries.
    const m = fakeManager([{ n: 0, mins: 0 }], []);
    await enforceBusinessCapacity(
      m.manager,
      'bot-1',
      rules({ maxBookingsPerDay: 5, minGapMin: 15 }),
      window60,
      TZ
    );
    expect(m.calls).toHaveLength(2);
    for (const c of m.calls) {
      expect(c.sql).toContain(`status IN ('pending','confirmed')`);
      expect(c.sql).not.toContain('request_created');
      expect(c.sql).not.toContain('cancelled');
    }
  });

  it('charges the CANDIDATE against the minutes budget, not just what is already booked', async () => {
    // An empty day and a 480-minute job against a 420-minute budget must be refused. A gate
    // that only looked at `used.mins` would wave this through.
    const m = fakeManager([{ n: 0, mins: 0 }]);
    const long = {
      ...window60,
      end: new Date(window60.start.getTime() + 480 * 60_000),
      blockedEnd: new Date(window60.start.getTime() + 480 * 60_000),
    };
    expect(
      await reason(() =>
        enforceBusinessCapacity(m.manager, 'bot-1', rules({ maxBookedMinutesPerDay: 420 }), long, TZ)
      )
    ).toBe('CAPACITY_REACHED:This business has no working time left that day');
  });

  it('lets a job that exactly fills the remaining budget through', async () => {
    // 360 used + 60 candidate = 420 against a 420 budget. `>=` here would refuse the last
    // job of every fully-planned day.
    const m = fakeManager([{ n: 0, mins: 360 }]);
    await expect(
      enforceBusinessCapacity(m.manager, 'bot-1', rules({ maxBookedMinutesPerDay: 420 }), window60, TZ)
    ).resolves.toBeUndefined();
  });

  it('reads minutes from the stored span so a null booked_duration_min cannot bill zero', async () => {
    const m = fakeManager([{ n: 0, mins: 0 }]);
    await enforceBusinessCapacity(m.manager, 'bot-1', rules({ maxBookedMinutesPerDay: 420 }), window60, TZ);
    expect(m.calls[0].sql).toContain('EXTRACT(EPOCH FROM (end_utc - start_utc))');
    expect(m.calls[0].sql).not.toContain('booked_duration_min');
  });

  it('pads the gap onto BOTH sides of the candidate range', async () => {
    // This is the whole of the min-gap feature at the write site. The old test re-implemented
    // the padding in the test body and asserted its own arithmetic, which proves nothing.
    const m = fakeManager([]);
    await enforceBusinessCapacity(m.manager, 'bot-1', rules({ minGapMin: 30 }), window60, TZ);
    expect(m.calls).toHaveLength(1); // no day query — neither day cap is set
    const [botId, from, to] = m.calls[0].params;
    expect(botId).toBe('bot-1');
    expect(from).toBe('2026-06-10T07:30:00.000Z'); // blockedStart − 30m
    expect(to).toBe('2026-06-10T09:30:00.000Z'); // blockedEnd + 30m
  });

  it('refuses a booking that lands inside another job’s gap', async () => {
    const m = fakeManager([{ '?column?': 1 }]);
    expect(
      await reason(() => enforceBusinessCapacity(m.manager, 'bot-1', rules({ minGapMin: 30 }), window60, TZ))
    ).toBe('CAPACITY_REACHED:That time is too close to another appointment');
  });

  it('excludes the moved booking from the gap check too', async () => {
    // Without this a reschedule of 15 minutes always fails: the row being moved sits well
    // inside its own padded range.
    const m = fakeManager([]);
    await enforceBusinessCapacity(m.manager, 'bot-1', rules({ minGapMin: 30 }), window60, TZ, 'bk-9');
    expect(m.calls[0].params[3]).toBe('bk-9');
    expect(m.calls[0].sql).toContain('id <> $4');
  });

  it('runs the day query and the gap query independently', async () => {
    const both = fakeManager([{ n: 0, mins: 0 }], []);
    await enforceBusinessCapacity(
      both.manager,
      'bot-1',
      rules({ maxBookingsPerDay: 5, minGapMin: 15 }),
      window60,
      TZ
    );
    expect(both.calls).toHaveLength(2);

    // A day cap alone must not fabricate a gap query — a zero gap would match the candidate's
    // own range and refuse every booking.
    const dayOnly = fakeManager([{ n: 0, mins: 0 }]);
    await enforceBusinessCapacity(dayOnly.manager, 'bot-1', rules({ maxBookingsPerDay: 5 }), window60, TZ);
    expect(dayOnly.calls).toHaveLength(1);
  });
});

/**
 * Intake answers, and the multi-answer that used to vanish.
 *
 * A `choice` question the customer answers more than once arrives as an ARRAY. The
 * normaliser dropped anything that was not a scalar, so the answer disappeared without a
 * trace: the owner's calendar entry showed the question with no reply, which reads as "the
 * customer declined to say" rather than "we lost it".
 */
describe('normalizeIntakeAnswers', () => {
  const svcWith = (ids: string[]) =>
    ({ intakeQuestions: ids.map((id) => ({ id, label: id, type: 'choice', required: false })) }) as never;

  it('keeps a multi-answer instead of dropping it', () => {
    const out = normalizeIntakeAnswers(svcWith(['q1']), { q1: ['Colour', 'Cut'] });
    expect(out).toEqual({ q1: 'Colour, Cut' });
  });

  it('keeps the scalar members of a mixed array and discards the rest', () => {
    // A nested object would otherwise render as "[object Object]" on the owner's calendar.
    const out = normalizeIntakeAnswers(svcWith(['q1']), { q1: ['Cut', { nested: true }, 3, null, 'Colour'] });
    expect(out).toEqual({ q1: 'Cut, 3, Colour' });
  });

  it('drops an array with nothing usable in it rather than storing an empty answer', () => {
    expect(normalizeIntakeAnswers(svcWith(['q1']), { q1: [null, {}, '  '] })).toBeNull();
  });

  it('still stores plain scalars, and still ignores unknown question ids', () => {
    const out = normalizeIntakeAnswers(svcWith(['q1']), { q1: 'Second floor', bogus: 'x' });
    expect(out).toEqual({ q1: 'Second floor' });
  });

  it('still refuses a non-object payload', () => {
    expect(normalizeIntakeAnswers(svcWith(['q1']), ['Cut'])).toBeNull();
    expect(normalizeIntakeAnswers(svcWith(['q1']), 'Cut')).toBeNull();
  });

  it('caps a long flattened answer like any other', () => {
    const out = normalizeIntakeAnswers(svcWith(['q1']), { q1: ['x'.repeat(1500), 'y'.repeat(1500)] });
    expect(out!.q1).toHaveLength(2000);
  });
});
