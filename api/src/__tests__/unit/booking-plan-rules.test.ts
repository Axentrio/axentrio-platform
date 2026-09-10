/**
 * Engine boundaries the booking test plan asks for that had NO coverage at any layer.
 *
 * Two of these (`AVL-07`, `AVL-08`) are genuine holes: nothing in the suite had ever called the
 * slot engine with a day that has more than one window, so a regression that offered appointments
 * inside the owner's lunch break — or sold a job that ran straight through it — would have left
 * every test green. For a business that closes over lunch, that is the difference between a diary
 * that works and one that books a plumber while they are eating.
 *
 * `SRV-07` is a defective test rather than a missing one. The only existing buffer test
 * (`slot-engine.test.ts:115-127`) asserts two things that BOTH still hold with the buffers zeroed,
 * so the buffer feature could be deleted outright and the suite would pass. The replacement below
 * is written so that zeroing the buffers makes it FAIL, and it says so.
 *
 * Dates: 2026-06-08 is a Monday, 06-09 Tuesday, 06-10 Wednesday; Brussels is CEST (UTC+2) in June,
 * so local 09:00 is 07:00Z.
 */
import { describe, it, expect } from 'vitest';
import { computeSlots, SlotEngineInput } from '../../booking/booking-providers/slot-engine';
import {
  resolveServiceTiming,
  PLATFORM_TIMING,
  type BusinessRules,
} from '../../booking/booking-providers/service-timing';
import type { ServiceType } from '../../database/entities/ServiceType';

function input(
  overrides: Partial<SlotEngineInput> & {
    weeklyHours?: SlotEngineInput['rule']['weeklyHours'];
    dateOverrides?: SlotEngineInput['rule']['dateOverrides'];
    availabilityMode?: SlotEngineInput['rule']['availabilityMode'];
    slotGranularityMin?: number;
  },
): SlotEngineInput {
  return {
    rule: {
      timezone: 'Europe/Brussels',
      availabilityMode: overrides.availabilityMode ?? 'business_hours',
      weeklyHours: overrides.weeklyHours ?? {},
      dateOverrides: overrides.dateOverrides ?? [],
      slotGranularityMin: overrides.slotGranularityMin ?? 30,
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
    business: overrides.business,
    dayLedger: overrides.dayLedger,
    serviceDayLedger: overrides.serviceDayLedger,
  };
}

const starts = (slots: { start: string }[]) => slots.map((s) => s.start);

/** A Wednesday that closes over lunch — the plan's §8 fixture for AVL-07/AVL-08. */
const LUNCH_BREAK_WEDNESDAY = {
  wed: [
    { start: '09:00', end: '12:00' },
    { start: '13:00', end: '17:00' },
  ],
};

describe('booking plan · availability boundaries', () => {
  /**
   * AVL-07 — Multiple availability blocks.
   *
   * Nothing had ever driven the engine with a two-window day. The 12:00–13:00 break must be a
   * hole in the diary, not a rounding artefact: the assertion is the FULL array, because the
   * failure this prevents is a single start quietly appearing inside the break.
   */
  describe('[AVL-07] when the day closes over lunch', () => {
    it('offers both windows and nothing inside the break', () => {
      const slots = computeSlots(input({ weeklyHours: LUNCH_BREAK_WEDNESDAY }));

      // 09:00–12:00 local = 07:00–10:00Z, and 13:00–17:00 local = 11:00–15:00Z.
      expect(starts(slots)).toEqual([
        '2026-06-10T07:00:00.000Z', // 09:00
        '2026-06-10T07:30:00.000Z', // 09:30
        '2026-06-10T08:00:00.000Z', // 10:00
        '2026-06-10T08:30:00.000Z', // 10:30
        '2026-06-10T09:00:00.000Z', // 11:00
        '2026-06-10T09:30:00.000Z', // 11:30
        // 10:00Z would be local 12:00 — the break. Not offered, and the whole point.
        '2026-06-10T11:00:00.000Z', // 13:00
        '2026-06-10T11:30:00.000Z', // 13:30
        '2026-06-10T12:00:00.000Z', // 14:00
        '2026-06-10T12:30:00.000Z', // 14:30
        '2026-06-10T13:00:00.000Z', // 15:00
        '2026-06-10T13:30:00.000Z', // 15:30
        '2026-06-10T14:00:00.000Z', // 16:00
        '2026-06-10T14:30:00.000Z', // 16:30
      ]);
    });

    it('offers nothing at all in the break, stated directly', () => {
      // The array above already implies this, but a reader (and a future refactor of the exact
      // list) should not have to diff 14 timestamps to see the invariant. 12:00/12:30 local are
      // the two candidate starts that would land in the break.
      const offered = starts(computeSlots(input({ weeklyHours: LUNCH_BREAK_WEDNESDAY })));
      expect(offered).not.toContain('2026-06-10T10:00:00.000Z'); // 12:00 local
      expect(offered).not.toContain('2026-06-10T10:30:00.000Z'); // 12:30 local
    });
  });

  /**
   * AVL-08 — A Service's full duration must fit inside ONE block.
   *
   * The danger here is an engine that validates only the START against the windows: an 11:30 start
   * looks fine on a 09:00–12:00 morning and then runs to 12:30, straight through the closure. This
   * is the same fixture as AVL-07 with a 60-minute Service, which is what makes the pair
   * meaningful — the only difference is the duration.
   */
  describe('[AVL-08] when a Service is longer than the gap allows', () => {
    it('refuses a start whose full duration would cross the break', () => {
      const slots = computeSlots(
        input({
          weeklyHours: LUNCH_BREAK_WEDNESDAY,
          eventType: { durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxHorizonDays: 60 },
        }),
      );

      // Morning: last start is 11:00 local (09:00Z), because 11:30→12:30 crosses the break.
      // Afternoon: last start is 16:00 local (14:00Z), because 16:30→17:30 crosses closing.
      expect(starts(slots)).toEqual([
        '2026-06-10T07:00:00.000Z', // 09:00 → 10:00
        '2026-06-10T07:30:00.000Z', // 09:30 → 10:30
        '2026-06-10T08:00:00.000Z', // 10:00 → 11:00
        '2026-06-10T08:30:00.000Z', // 10:30 → 11:30
        '2026-06-10T09:00:00.000Z', // 11:00 → 12:00, ending exactly at the break
        '2026-06-10T11:00:00.000Z', // 13:00 → 14:00
        '2026-06-10T11:30:00.000Z', // 13:30 → 14:30
        '2026-06-10T12:00:00.000Z', // 14:00 → 15:00
        '2026-06-10T12:30:00.000Z', // 14:30 → 15:30
        '2026-06-10T13:00:00.000Z', // 15:00 → 16:00
        '2026-06-10T13:30:00.000Z', // 15:30 → 16:30
        '2026-06-10T14:00:00.000Z', // 16:00 → 17:00, ending exactly at closing
      ]);
    });

    it('never returns a start whose duration leaves the window it started in', () => {
      // The structural form of the same invariant, independent of the exact list above: no
      // returned slot may overlap the closed 12:00–13:00 local interval (10:00Z–11:00Z).
      const slots = computeSlots(
        input({
          weeklyHours: LUNCH_BREAK_WEDNESDAY,
          eventType: { durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxHorizonDays: 60 },
        }),
      );
      const breakStart = Date.parse('2026-06-10T10:00:00Z');
      const breakEnd = Date.parse('2026-06-10T11:00:00Z');
      for (const slot of slots) {
        const s = Date.parse(slot.start);
        const e = Date.parse(slot.end);
        expect(e <= breakStart || s >= breakEnd).toBe(true);
      }
    });
  });

  /**
   * SRV-07 — Service buffers, and the test that could not fail.
   *
   * The pre-existing buffer test asserts (a) that the 08:00Z start is absent and (b) that 07:00Z is
   * present. Both are still true with `bufferBeforeMin`/`bufferAfterMin` set to 0 — (a) because the
   * busy interval itself already masks 08:00Z, and (b) because 07:00Z is clear either way. So the
   * buffers could be deleted and that test would stay green.
   *
   * The discriminating start is 07:30Z. With 15/15 buffers its blocked window is 07:15–08:15,
   * which overlaps the 08:00–08:15 busy interval; with no buffers it is clear. The control below
   * runs the SAME fixture with the buffers zeroed, so the test proves it is the buffer doing the
   * work rather than a coincidence of the fixture.
   */
  describe('[SRV-07] buffers reserve prep and cleanup time', () => {
    const WINDOW = { wed: [{ start: '09:00', end: '11:00' }] };
    const BUSY = [{ start: new Date('2026-06-10T08:00:00Z'), end: new Date('2026-06-10T08:15:00Z') }];

    it('withholds a start that only the buffer makes infeasible', () => {
      const buffered = computeSlots(
        input({
          weeklyHours: WINDOW,
          busy: BUSY,
          eventType: {
            durationMin: 30, bufferBeforeMin: 15, bufferAfterMin: 15, minNoticeMin: 0, maxHorizonDays: 60,
          },
        }),
      );
      // 07:30Z + its 15-minute after-buffer reaches 08:15Z, which touches the busy interval.
      expect(starts(buffered)).not.toContain('2026-06-10T07:30:00.000Z');
      expect(starts(buffered)).toEqual([
        '2026-06-10T07:00:00.000Z',
        '2026-06-10T08:30:00.000Z',
      ]);
    });

    it('control: with the buffers zeroed that same start IS offered', () => {
      // This is the assertion that makes the test above mean something. If a future change stops
      // applying buffers, the buffered case fails; if the fixture changes so the buffers no longer
      // decide the outcome, these two cases agree and the difference disappears — which is exactly
      // the signal that the test has stopped testing anything.
      const unbuffered = computeSlots(
        input({
          weeklyHours: WINDOW,
          busy: BUSY,
          eventType: {
            durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxHorizonDays: 60,
          },
        }),
      );
      expect(starts(unbuffered)).toContain('2026-06-10T07:30:00.000Z');
    });
  });

  /**
   * AVL-02 — Always open must bypass a CONFIGURED grid, and overrides must still beat it.
   *
   * Every existing `always_open` fixture pairs the mode with an EMPTY `weeklyHours`, so a mode that
   * failed to bypass a populated grid would pass. The fixture here deliberately carries a narrow
   * 09:00–11:00 grid that the mode has to ignore.
   */
  describe('[AVL-02] always open 24/7', () => {
    // The range is the LOCAL day, not the UTC day. A UTC day in Brussels starts at 02:00 local and
    // ends at 02:00 the next local day, so it straddles two business days — which silently defeats
    // any "the whole day is closed" assertion. 06-09T22:00Z is local midnight on 06-10.
    const WEDNESDAY_LOCAL_DAY = { start: '2026-06-09T22:00:00Z', end: '2026-06-10T22:00:00Z' };

    it('is bookable outside a weekly grid that is still configured', () => {
      const slots = computeSlots(
        input({
          availabilityMode: 'always_open',
          weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] },
          rangeStart: WEDNESDAY_LOCAL_DAY.start,
          rangeEnd: WEDNESDAY_LOCAL_DAY.end,
          now: new Date('2026-06-09T22:00:00Z'),
        }),
      );
      // Local 20:00 = 18:00Z, far outside the configured 09:00–11:00 grid. Under the grid this
      // start could never be produced.
      expect(starts(slots)).toContain('2026-06-10T18:00:00.000Z');
      // A full local day on a 30-minute grid is 48 starts. The grid alone would yield 4.
      expect(slots.length).toBe(48);
    });

    it('still honours a date override that closes the day', () => {
      // Overrides win even over always-open (docs/booking-rules.md:79), otherwise a holiday could
      // not be taken by a business that leaves the mode on.
      const slots = computeSlots(
        input({
          availabilityMode: 'always_open',
          weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] },
          dateOverrides: [{ date: '2026-06-10', closed: true }],
          rangeStart: WEDNESDAY_LOCAL_DAY.start,
          rangeEnd: WEDNESDAY_LOCAL_DAY.end,
          now: new Date('2026-06-09T22:00:00Z'),
        }),
      );
      expect(slots).toEqual([]);
    });
  });

  /**
   * AVL-03 — The requested weekday's OWN windows decide, at engine level.
   *
   * The existing pin for a Tuesday that opens at 12:00 runs against INJECTED slots with
   * `checkAvailability` mocked, so it cannot fail on engine boundary logic. Here two weekdays carry
   * genuinely different windows in one rule, and the difference in the first offered start is the
   * proof the engine reads the day rather than a shared default.
   */
  describe('[AVL-03] a weekday uses its own hours', () => {
    const DIFFERING = {
      mon: [{ start: '09:00', end: '17:00' }],
      tue: [{ start: '12:00', end: '18:00' }],
    };

    it('starts Tuesday at its own opening time, not Monday\u2019s', () => {
      const tuesday = computeSlots(
        input({ weeklyHours: DIFFERING, rangeStart: '2026-06-09T00:00:00Z', rangeEnd: '2026-06-10T00:00:00Z' }),
      );
      // 12:00 local = 10:00Z. Anything before it would mean Monday's 09:00 leaked into Tuesday.
      expect(starts(tuesday)[0]).toBe('2026-06-09T10:00:00.000Z');
      expect(starts(tuesday)).not.toContain('2026-06-09T07:00:00.000Z');
    });

    it('still starts Monday at 09:00 local, from the same rule', () => {
      const monday = computeSlots(
        input({ weeklyHours: DIFFERING, rangeStart: '2026-06-08T00:00:00Z', rangeEnd: '2026-06-09T00:00:00Z' }),
      );
      expect(starts(monday)[0]).toBe('2026-06-08T07:00:00.000Z');
    });
  });
});

// ── Timing inheritance: resolved AND enforced ────────────────────────────────
//
// The plan's AVL-12/AVL-13 ask that a Service which inherits the business-wide minimum notice or
// maximum horizon actually has it applied. The inheritance ARITHMETIC was already pinned
// (business-capacity.test.ts:157-161), but every refusal fixture put the value on the Service — so
// a wiring break that ignored the owner's business-wide setting left the suite green.
//
// These tests go the whole way: resolve the Service against a business row that is the ONLY source
// of the value, then feed the resolved timing into the engine and assert the refusal. That covers
// the seam the arithmetic test cannot see.

describe('booking plan · inherited timing is enforced, not merely computed', () => {
  const svc = (over: Partial<ServiceType> = {}) =>
    ({
      id: 'svc-timing',
      name: 'Booking test',
      durationMin: 30,
      // null = "inherit", which is the whole reason these columns are nullable.
      bufferBeforeMin: null,
      bufferAfterMin: null,
      minNoticeMin: null,
      maxHorizonDays: null,
      ...over,
    }) as unknown as ServiceType;

  const business = (over: Partial<BusinessRules> = {}): BusinessRules =>
    ({
      maxBookingsPerDay: 0,
      maxBookedMinutesPerDay: 0,
      minGapMin: 0,
      defaultBufferBeforeMin: null,
      defaultBufferAfterMin: null,
      defaultMinNoticeMin: null,
      defaultMaxHorizonDays: null,
      venue: {},
      ...over,
    }) as BusinessRules;

  describe('[AVL-12] minimum notice inherited from the business', () => {
    it('refuses a slot inside the inherited notice window', () => {
      const resolved = resolveServiceTiming(svc(), business({ defaultMinNoticeMin: 1440 }));
      expect(resolved.minNoticeMin).toBe(1440);

      // One day of notice, and a slot the next morning: inside the window, so nothing is offered.
      const slots = computeSlots(
        input({
          weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] },
          now: new Date('2026-06-09T12:00:00Z'),
          eventType: {
            durationMin: resolved.durationMin,
            bufferBeforeMin: resolved.bufferBeforeMin,
            bufferAfterMin: resolved.bufferAfterMin,
            minNoticeMin: resolved.minNoticeMin,
            maxHorizonDays: resolved.maxHorizonDays,
          },
        }),
      );
      expect(slots).toEqual([]);
    });

    it('control: with no business default and no Service value, the same slot is offered', () => {
      // Proves the refusal above came from the INHERITED number rather than from the fixture.
      const resolved = resolveServiceTiming(svc(), business());
      expect(resolved.minNoticeMin).toBe(PLATFORM_TIMING.minNoticeMin);

      const slots = computeSlots(
        input({
          weeklyHours: { wed: [{ start: '09:00', end: '11:00' }] },
          now: new Date('2026-06-09T12:00:00Z'),
          eventType: {
            durationMin: resolved.durationMin,
            bufferBeforeMin: resolved.bufferBeforeMin,
            bufferAfterMin: resolved.bufferAfterMin,
            minNoticeMin: resolved.minNoticeMin,
            maxHorizonDays: resolved.maxHorizonDays,
          },
        }),
      );
      expect(starts(slots)).toEqual([
        '2026-06-10T07:00:00.000Z',
        '2026-06-10T07:30:00.000Z',
        '2026-06-10T08:00:00.000Z',
        '2026-06-10T08:30:00.000Z',
      ]);
    });

    it('an explicit Service 0 is a real answer and beats the business default', () => {
      // The documented trap: `null` inherits, `0` does not. A Service that genuinely wants no
      // notice must not silently acquire the owner's 24 hours.
      const resolved = resolveServiceTiming(svc({ minNoticeMin: 0 }), business({ defaultMinNoticeMin: 1440 }));
      expect(resolved.minNoticeMin).toBe(0);
    });
  });

  describe('[AVL-13] maximum horizon inherited from the business', () => {
    it('refuses a day beyond the inherited horizon', () => {
      const resolved = resolveServiceTiming(svc(), business({ defaultMaxHorizonDays: 14 }));
      expect(resolved.maxHorizonDays).toBe(14);

      // now = 2026-06-01, so a 2026-06-20 slot is 19 days out — past the inherited 14.
      const slots = computeSlots(
        input({
          weeklyHours: { sat: [{ start: '09:00', end: '11:00' }] },
          rangeStart: '2026-06-20T00:00:00Z',
          rangeEnd: '2026-06-21T00:00:00Z',
          now: new Date('2026-06-01T00:00:00Z'),
          eventType: {
            durationMin: resolved.durationMin,
            bufferBeforeMin: resolved.bufferBeforeMin,
            bufferAfterMin: resolved.bufferAfterMin,
            minNoticeMin: resolved.minNoticeMin,
            maxHorizonDays: resolved.maxHorizonDays,
          },
        }),
      );
      expect(slots).toEqual([]);
    });

    it('the Service\u2019s own horizon wins over the business default', () => {
      // Service 30 days is LOOSER than the business 14. These are Business Defaults, not Capacity
      // Ceilings, so the Service wins even when it is the more permissive of the two — the opposite
      // of the ceiling rule, which is the mistake this asserts against.
      const resolved = resolveServiceTiming(svc({ maxHorizonDays: 30 }), business({ defaultMaxHorizonDays: 14 }));
      expect(resolved.maxHorizonDays).toBe(30);

      const slots = computeSlots(
        input({
          weeklyHours: { sat: [{ start: '09:00', end: '11:00' }] },
          rangeStart: '2026-06-20T00:00:00Z',
          rangeEnd: '2026-06-21T00:00:00Z',
          now: new Date('2026-06-01T00:00:00Z'),
          eventType: {
            durationMin: resolved.durationMin,
            bufferBeforeMin: resolved.bufferBeforeMin,
            bufferAfterMin: resolved.bufferAfterMin,
            minNoticeMin: resolved.minNoticeMin,
            maxHorizonDays: resolved.maxHorizonDays,
          },
        }),
      );
      expect(starts(slots)).toEqual([
        '2026-06-20T07:00:00.000Z',
        '2026-06-20T07:30:00.000Z',
        '2026-06-20T08:00:00.000Z',
        '2026-06-20T08:30:00.000Z',
      ]);
    });
  });

  /**
   * SRV-09 — the horizon bound is an INSTANT, and the inclusive edge was never exercised.
   *
   * Existing coverage only reached the bound at day level, roughly 11 hours inside it, so flipping
   * the comparator at `slot-engine.ts:285` from `>` to `>=` left every test green. Here the fixture
   * is built so that one candidate lands EXACTLY on the bound and the next one is 30 minutes past
   * it. A `>=` comparator drops the boundary slot and this test produces `[]`, which is the
   * discriminating signal.
   *
   * Note what is pinned: the plan says "the 14-day boundary is allowed". The engine implements that
   * as *a start exactly at `now + horizonDays` is allowed; one minute later is not* — an instant
   * bound, not a whole-day one. Pinning the instant is deliberate, so a future change to day-level
   * semantics has to be a decision rather than an accident.
   */
  describe('[SRV-09] the maximum horizon boundary', () => {
    it('allows a start exactly on the bound and refuses the next one', () => {
      // 2026-06-15 is a Monday. now = 07:00Z on 06-01, horizon 14 days ⇒ bound = 06-15T07:00Z,
      // which is exactly local 09:00 — the day's first grid start.
      const slots = computeSlots(
        input({
          weeklyHours: { mon: [{ start: '09:00', end: '11:00' }] },
          rangeStart: '2026-06-15T00:00:00Z',
          rangeEnd: '2026-06-16T00:00:00Z',
          now: new Date('2026-06-01T07:00:00Z'),
          eventType: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxHorizonDays: 14 },
        }),
      );

      expect(starts(slots)).toEqual(['2026-06-15T07:00:00.000Z']);
      // Stated separately so the boundary is legible: 30 minutes later is outside the horizon.
      expect(starts(slots)).not.toContain('2026-06-15T07:30:00.000Z');
    });

    it('slides with now: an hour later, one more start fits', () => {
      // The bound is `now + horizonDays`, so it moves with the clock rather than being pinned to a
      // calendar day. One hour later the bound is 08:00Z, which admits local 10:00 as the last
      // start and still refuses local 10:30. Asserting the slide (rather than a fixed array) is
      // what catches a "horizon" implemented as a date comparison instead of an instant one.
      const slots = computeSlots(
        input({
          weeklyHours: { mon: [{ start: '09:00', end: '11:00' }] },
          rangeStart: '2026-06-15T00:00:00Z',
          rangeEnd: '2026-06-16T00:00:00Z',
          now: new Date('2026-06-01T08:00:00Z'),
          eventType: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxHorizonDays: 14 },
        }),
      );
      expect(starts(slots)).toEqual([
        '2026-06-15T07:00:00.000Z', // 09:00
        '2026-06-15T07:30:00.000Z', // 09:30
        '2026-06-15T08:00:00.000Z', // 10:00, exactly on the moved bound
      ]);
      expect(starts(slots)).not.toContain('2026-06-15T08:30:00.000Z');
    });
  });
});
