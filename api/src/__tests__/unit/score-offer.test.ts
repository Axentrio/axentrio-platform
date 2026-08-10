/**
 * #81 - the seam between the travel gate and the scorer.
 *
 * The unit tests either side of this are pure: `insertion-scorer` gets candidates and anchors
 * handed to it, and `slot-ordering` gets scores. Everything that can go wrong in BETWEEN them is
 * here - which day a slot belongs to, which anchors belong to that day, and what happens when the
 * whole thing fails. A slot list routinely spans a fortnight, so "score the candidate against the
 * day's other jobs" is the one property the pure tests cannot state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const driveLookupFor = vi.fn();
vi.mock('../../booking/travel/routes.service', () => ({ driveLookupFor: (...a: unknown[]) => driveLookupFor(...a) }));

import { scoreOfferedSlots } from '../../booking/travel/score-offer';
import { SCORER_VERSION } from '../../booking/travel/slot-ordering';
import { GROUPING_DEADLINE_MS } from '../../booking/travel/grouping-budget';
import type { TravelNeighbour } from '../../booking/travel/travel-gate';
import type { DayRule } from '../../booking/travel/travel-day';

/** London, so a UTC instant and a local day are not the same string in summer. */
const rule = {
  timezone: 'Europe/London',
  availabilityMode: 'business_hours',
  // The engine's own keys. Long weekday names read fine and silently match nothing, which is
  // worth stating: a mis-shaped rule makes the scorer go neutral rather than fail.
  weeklyHours: {
    mon: [{ start: '08:00', end: '18:00' }],
    tue: [{ start: '08:00', end: '18:00' }],
    wed: [{ start: '08:00', end: '18:00' }],
    thu: [{ start: '08:00', end: '18:00' }],
    fri: [{ start: '08:00', end: '18:00' }],
    sat: [],
    sun: [],
  },
  dateOverrides: [],
};

const eligibility = {
  active: true as const,
  tenantId: 'tenant-1',
  itineraryKey: 'bot:1',
  slackMin: 0,
  startFromBase: false,
  maxDetourMin: null, baseDepartOffsetMin: 0,
};

/** Monday 8 Sep 2026 and Tuesday 9 Sep 2026, both inside the London working day. */
const MON = '2026-09-07';
const TUE = '2026-09-08';
const utc = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000Z`);
const slot = (day: string, hhmm: string) => ({
  start: utc(day, hhmm).toISOString(),
  end: utc(day, hhmm === '10:00' ? '11:00' : '15:00').toISOString(),
});

const neighbour = (day: string, hhmm: string, lat: number): TravelNeighbour => ({
  blockedStart: utc(day, hhmm),
  blockedEnd: new Date(utc(day, hhmm).getTime() + 3_600_000),
  location: { kind: 'known', point: { lat, lng: 0 } },
});

const base = { eligibility, sessionId: 'sess-1', rule: rule as DayRule, candidatePoint: { lat: 51.5, lng: -0.1 } };
const noBase = { baseFor: () => ({ base: null }) };

beforeEach(() => {
  driveLookupFor.mockReset();
  // Every leg is 20 minutes, so any cost difference between days can only come from WHICH legs
  // were measured - which is exactly what these tests are about.
  driveLookupFor.mockReturnValue(async () => ({ minutes: 20 }));
});

describe('which day a slot is scored against', () => {
  // These are arranged AFTERNOON-side on purpose, and the arrangement is the test. `periodOf`
  // compares a range against one boundary instant and knows nothing about dates, so tomorrow's
  // 16:00 job sorts into TODAY's afternoon quite happily. The day filter is the only thing
  // stopping it, and a morning-side arrangement cannot show that: the next day's job lands after
  // every candidate anyway, so it is never picked as a neighbour and the bug stays invisible.
  it("never uses another day's job as a candidate's neighbour", async () => {
    const legs: Array<{ lat: number }> = [];
    driveLookupFor.mockReturnValue(async (leg: { from: { lat: number }; to: { lat: number } }) => {
      legs.push({ lat: leg.from.lat }, { lat: leg.to.lat });
      return { minutes: 20 };
    });

    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      // Monday afternoon, with the only job in the diary on TUESDAY afternoon.
      slots: [{ start: utc(MON, '14:00').toISOString(), end: utc(MON, '15:00').toISOString() }],
      requestable: [],
      neighbours: [neighbour(TUE, '15:00', 2)],
    });

    // Monday has no jobs, so there is nothing to be near and nothing to measure. Without the day
    // filter, Tuesday's job becomes Monday's `next` and a drive to tomorrow is priced into today.
    expect(legs).toEqual([]);
    expect(result!.scores[utc(MON, '14:00').toISOString()]).toMatchObject({
      costMinutes: null,
      neutralReason: 'unanchored',
    });
  });

  it("prices a day's candidate against that day's jobs only", async () => {
    const legs: Array<{ lat: number }> = [];
    driveLookupFor.mockReturnValue(async (leg: { from: { lat: number }; to: { lat: number } }) => {
      legs.push({ lat: leg.from.lat }, { lat: leg.to.lat });
      return { minutes: 20 };
    });

    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      slots: [{ start: utc(MON, '14:00').toISOString(), end: utc(MON, '15:00').toISOString() }],
      requestable: [],
      // Monday's job ends exactly where the candidate starts; Tuesday's is a decoy.
      neighbours: [neighbour(MON, '13:00', 1), neighbour(TUE, '15:00', 2)],
    });

    // ONE leg: Monday's job to the candidate. A second leg would mean Tuesday's job was treated
    // as what the van drives to next, which is a cost the owner will never pay on Monday.
    expect(legs).toEqual([{ lat: 1 }, { lat: 51.5 }]);
    expect(result!.scores[utc(MON, '14:00').toISOString()].costMinutes).toBe(20);
  });
});

describe('what comes back', () => {
  it('is plain JSON, keyed by instant, and survives a serialising hop', async () => {
    // The offer record is written at DISPATCH, a channel boundary away. A Map here would arrive
    // as `{}` and the row would claim a scorer ran while recording nothing it decided.
    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      slots: [slot(MON, '10:00')],
      requestable: [],
      neighbours: [neighbour(MON, '09:00', 1)],
    });

    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped.scores[utc(MON, '10:00').toISOString()]).toBeDefined();
    expect(roundTripped.scorerVersion).toBe(SCORER_VERSION);
    expect(roundTripped.counterfactualOrder).toEqual([utc(MON, '10:00').toISOString()]);
  });

  it('asks for a cache-only lookup, which is what makes this shadow rather than merely cheap', async () => {
    // Not a cheaper lookup - a lookup that CANNOT spend. Grouping shares one monthly counter with
    // the feasibility gate, so any spend at all can push a tenant into an exhaustion they would
    // not otherwise have reached, and an exhausted gate turns confirmable slots into Requests.
    await scoreOfferedSlots({
      ...base,
      ...noBase,
      slots: [slot(MON, '10:00')],
      requestable: [],
      neighbours: [neighbour(MON, '09:00', 1)],
    });

    expect(driveLookupFor).toHaveBeenCalledWith(eligibility, 'sess-1', expect.objectContaining({ cacheOnly: true }));
  });

  it('counts the legs it declined to buy, which is the cost question answered for free', async () => {
    let onWouldSpend: (() => void) | undefined;
    driveLookupFor.mockImplementation((_e: unknown, _s: unknown, opts: { onWouldSpend?: () => void }) => {
      onWouldSpend = opts?.onWouldSpend;
      return async () => {
        // One leg was in this conversation's cache and one was not. Only the second is a cost.
        onWouldSpend?.();
        return { minutes: 20 };
      };
    });

    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      slots: [slot(MON, '10:00')],
      requestable: [],
      neighbours: [neighbour(MON, '09:00', 1)],
    });

    expect(result!.elementsWouldSpend).toBe(1);
  });

  it('answers null for an empty list rather than an empty scoring', async () => {
    // An offer with no slots has nothing to prefer, and a row saying "scored, nothing found" would
    // be counted in the denominator of every LP4 question.
    expect(await scoreOfferedSlots({ ...base, ...noBase, slots: [], requestable: [], neighbours: [] })).toBeNull();
  });
});

describe('when the pass runs out of time', () => {
  it('records nothing rather than a full-list conclusion drawn from half a list', async () => {
    // The failure this prevents is silent and permanent. `cheaperAlternativeExisted` is a claim
    // that NOWHERE better existed; computed from a pass that stopped early it answers `false`
    // because the cheaper slot was never reached - the exact number LP4 exists to produce, wrong,
    // in a row indistinguishable from a complete one. Absence is already a first-class state.
    driveLookupFor.mockReturnValue(
      async () => new Promise((resolve) => setTimeout(() => resolve({ minutes: 20 }), 10_000))
    );

    const started = Date.now();
    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      slots: [{ start: utc(MON, '14:00').toISOString(), end: utc(MON, '15:00').toISOString() }],
      requestable: [],
      neighbours: [neighbour(MON, '13:00', 1)],
    });

    expect(result).toBeNull();
    // ...and it came back at the bound rather than at the router's own 5-second timeout. A shadow
    // measurement is awaited inside a customer-facing availability call.
    expect(Date.now() - started).toBeLessThan(GROUPING_DEADLINE_MS + 1_500);
  }, 20_000);
});

describe('when scoring itself breaks', () => {
  it('records nothing when the pass fails PART-WAY, not just when it fails to start', async () => {
    // A distinct hole from the one below, and the sharper of the two. The pass is raced against a
    // deadline, so its rejection is handled rather than thrown - which means a mid-pass failure
    // resolves the race quite normally with the deadline never reached, and everything downstream
    // reads a half-filled map as a finished one.
    //
    // Thrown from `baseFor` rather than from the router, and the distinction is the point: a leg
    // the router cannot measure is ALREADY handled, and correctly - that candidate scores neutral
    // and the pass is still complete. `baseFor` is a closure the caller owns that reads the day's
    // rule and venue, so it is the realistic way a pass dies half-finished.
    let day = 0;
    const baseFails = {
      baseFor: () => {
        day += 1;
        if (day > 1) throw new Error('venue lookup died mid-pass');
        return { base: null };
      },
    };

    const result = await scoreOfferedSlots({
      ...base,
      ...baseFails,
      slots: [
        { start: utc(MON, '14:00').toISOString(), end: utc(MON, '15:00').toISOString() },
        { start: utc(TUE, '14:00').toISOString(), end: utc(TUE, '15:00').toISOString() },
      ],
      requestable: [],
      neighbours: [neighbour(MON, '13:00', 1), neighbour(TUE, '13:00', 2)],
    });

    // Not "Monday's score with Tuesday missing". `cheaperAlternativeExisted` is a claim about
    // every slot offered, and a claim drawn from the half that happened to finish is wrong in the
    // one direction that matters - it says nowhere better existed.
    expect(result).toBeNull();
  });

  it('answers null instead of throwing, so the slot list is unaffected', async () => {
    // ADR-0017: grouping may prefer a slot and may never refuse one. An exception escaping here
    // would take out the whole availability answer for a preference that is optional by design.
    driveLookupFor.mockImplementation(() => {
      throw new Error('router exploded');
    });

    await expect(
      scoreOfferedSlots({
        ...base,
        ...noBase,
        slots: [slot(MON, '10:00')],
        requestable: [],
        neighbours: [neighbour(MON, '09:00', 1)],
      })
    ).resolves.toBeNull();
  });
});
