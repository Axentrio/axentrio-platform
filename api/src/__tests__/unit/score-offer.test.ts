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
  maxDetourMin: null, baseDepartOffsetMin: 0, groupingPeriod: 'none' as const,
};

/** Monday 8 Sep 2026 and Tuesday 9 Sep 2026, both inside the London working day. */
const MON = '2026-09-07';
const TUE = '2026-09-08';
const utc = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000Z`);
const slot = (day: string, hhmm: string) => ({
  start: utc(day, hhmm).toISOString(),
  end: utc(day, hhmm === '10:00' ? '11:00' : '15:00').toISOString(),
});

const neighbour = (
  day: string,
  hhmm: string,
  lat: number,
  status: 'confirmed' | 'pending' = 'confirmed'
): TravelNeighbour => ({
  blockedStart: utc(day, hhmm),
  blockedEnd: new Date(utc(day, hhmm).getTime() + 3_600_000),
  location: { kind: 'known', point: { lat, lng: 0 } },
  status,
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

  it('buys the baseline leg and refuses to buy the ones beside the candidate', async () => {
    // THE fix. Adjacent legs are the pairs feasibility just routed, so they are free or not had at
    // all - buying one would be grouping paying to redo the gate's own work. The baseline is the
    // leg nothing else ever asks for, so it is never cached and somebody has to buy it.
    const asked: Array<{ cacheOnly: boolean; from: number }> = [];
    driveLookupFor.mockImplementation((_e: unknown, _s: unknown, opts: { cacheOnly?: boolean }) => {
      return async (leg: { from: { lat: number } }) => {
        asked.push({ cacheOnly: opts?.cacheOnly === true, from: leg.from.lat });
        return { minutes: 20 };
      };
    });

    await scoreOfferedSlots({
      ...base,
      ...noBase,
      // Sandwiched: a job before AND after, which is what needs a baseline at all.
      slots: [{ start: utc(MON, '14:00').toISOString(), end: utc(MON, '15:00').toISOString() }],
      requestable: [],
      neighbours: [neighbour(MON, '13:00', 1), neighbour(MON, '16:00', 2)],
    });

    // Three legs: two adjacent on the free lookup, one baseline on the paying one.
    expect(asked.filter((a) => a.cacheOnly)).toHaveLength(2);
    const bought = asked.filter((a) => !a.cacheOnly);
    expect(bought).toHaveLength(1);
    // ...and the bought one is anchor-to-anchor, never anything touching the candidate.
    expect(bought[0].from).toBe(1);
  });

  it('scores a candidate with a job on BOTH sides, which is the case it used to be blind to', async () => {
    // The regression this fix exists for. Spending nothing at all left every sandwiched candidate
    // on `leg_unmeasured`, measured live: 10 offers, 63 slots, and not one scored slot had
    // neighbours on both sides. The blind spot was precisely the mid-day insertion grouping is for.
    // The real router fires `onBilled` at the reservation, so a mock that skips it would leave
    // the spend counter at zero and the budget guard permanently open.
    driveLookupFor.mockImplementation((_e: unknown, _s: unknown, opts: { cacheOnly?: boolean; onBilled?: () => void }) => {
      return async () => {
        if (opts?.cacheOnly !== true) opts?.onBilled?.();
        return { minutes: 20 };
      };
    });

    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      slots: [{ start: utc(MON, '14:00').toISOString(), end: utc(MON, '15:00').toISOString() }],
      requestable: [],
      neighbours: [neighbour(MON, '13:00', 1), neighbour(MON, '16:00', 2)],
    });

    const scored = result!.scores[utc(MON, '14:00').toISOString()];
    // 20 there + 20 onward - 20 the anchors already cost each other = 20 added.
    expect(scored.costMinutes).toBe(20);
    expect(scored.neutralReason).toBeNull();
    expect(result!.elementsSpent).toBe(1);
  });

  it('buys a gap ONCE however many candidates sit in it, with no drive cache at all', async () => {
    // The magnitude this whole design is justified by. The drive cache would usually collapse
    // these, but only usually: it is skipped when the session id is null, unavailable when Redis
    // is down, never holds a failed answer, and `trafficAware` flips at the 24-hour horizon and
    // makes two keys for one instant. Under any of those every candidate in the gap would re-buy
    // the identical leg, and "about one element per gap" would quietly become per-candidate.
    let bought = 0;
    driveLookupFor.mockImplementation((_e: unknown, _s: unknown, opts: { cacheOnly?: boolean; onBilled?: () => void }) => {
      return async (leg: { from: { lat: number }; to: { lat: number } }) => {
        const touchesCandidate = leg.from.lat === 51.5 || leg.to.lat === 51.5;
        // A cache that answers NOTHING, which is what a null session or a dead Redis looks like.
        if (opts?.cacheOnly === true) return touchesCandidate ? { minutes: 20 } : { minutes: null };
        bought += 1;
        opts?.onBilled?.();
        return { minutes: 20 };
      };
    });

    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      sessionId: null,
      // Four candidates, all in the SAME gap between the same two jobs.
      slots: ['14:00', '14:30', '15:00', '15:30'].map((t) => ({
        start: utc(MON, t).toISOString(),
        end: utc(MON, t === '15:30' ? '16:00' : '15:00').toISOString(),
      })),
      requestable: [],
      neighbours: [neighbour(MON, '13:00', 1), neighbour(MON, '16:30', 2)],
    });

    expect(bought).toBe(1);
    expect(result!.elementsSpent).toBe(1);
  });

  it('does not re-buy a baseline that already FAILED this pass', async () => {
    // A failed answer is deliberately never written to the drive cache, so without an in-pass memo
    // every candidate in the gap would pay again for the same failure.
    let bought = 0;
    driveLookupFor.mockImplementation((_e: unknown, _s: unknown, opts: { cacheOnly?: boolean; onBilled?: () => void }) => {
      return async (leg: { from: { lat: number }; to: { lat: number } }) => {
        const touchesCandidate = leg.from.lat === 51.5 || leg.to.lat === 51.5;
        if (opts?.cacheOnly === true) return touchesCandidate ? { minutes: 20 } : { minutes: null };
        bought += 1;
        opts?.onBilled?.();
        return { minutes: null, cause: 'no_route' };
      };
    });

    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      sessionId: null,
      slots: ['14:00', '14:30', '15:00'].map((t) => ({
        start: utc(MON, t).toISOString(),
        end: utc(MON, t === '15:00' ? '16:00' : '15:00').toISOString(),
      })),
      requestable: [],
      neighbours: [neighbour(MON, '13:00', 1), neighbour(MON, '16:30', 2)],
    });

    expect(bought).toBe(1);
    // Every candidate is neutral rather than refused, which is ADR-0017 holding on a failure.
    expect(Object.values(result!.scores).every((x) => x.costMinutes === null)).toBe(true);
  });

  it('stops buying at the paid budget and goes neutral rather than stopping the pass', async () => {
    // A hard per-pass count, not a share of the tenant's month. Past it the remaining candidates
    // carry no preference, which refuses nothing - ADR-0017's rule holds whatever the budget does.
    const { GROUPING_PAID_LEG_BUDGET } = await import('../../booking/travel/grouping-budget');
    let bought = 0;
    // The cache mirrors reality: it holds the legs feasibility routed, which always touch the
    // candidate, and never anchor-to-anchor. A mock that answers everything would let a candidate
    // score past the budget and hide the very degradation being tested.
    driveLookupFor.mockImplementation((_e: unknown, _s: unknown, opts: { cacheOnly?: boolean; onBilled?: () => void }) => {
      return async (leg: { from: { lat: number }; to: { lat: number } }) => {
        const touchesCandidate = leg.from.lat === 51.5 || leg.to.lat === 51.5;
        if (opts?.cacheOnly === true) return touchesCandidate ? { minutes: 20 } : { minutes: null };
        bought += 1;
        opts?.onBilled?.();
        return { minutes: 20 };
      };
    });

    // One gap per day, so more days than the budget allows is the cheapest way to exceed it.
    const days = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14'];
    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      slots: days.map((d) => ({ start: utc(d, '14:00').toISOString(), end: utc(d, '15:00').toISOString() })),
      requestable: [],
      neighbours: days.flatMap((d) => [neighbour(d, '13:00', 1), neighbour(d, '16:00', 2)]),
    });

    expect(bought).toBe(GROUPING_PAID_LEG_BUDGET);
    expect(result!.elementsSpent).toBe(GROUPING_PAID_LEG_BUDGET);
    // The days past the budget are neutral, not missing and not refused.
    const neutral = Object.values(result!.scores).filter((s) => s.neutralReason === 'leg_unmeasured');
    expect(neutral.length).toBe(days.length - GROUPING_PAID_LEG_BUDGET);
  });

  it('bounds the legs it READS across the whole pass, not per day', async () => {
    // A cache hit costs no money and does cost time, and the leg budget is a bound on the customer
    // waiting behind a live availability call. `scoreCandidates` counts within ONE call and the
    // pass makes one call per day, so without an outer counter a fortnight of days would each
    // start with a full budget and the advertised bound would mean nothing.
    const { GROUPING_LEG_BUDGET } = await import('../../booking/travel/grouping-budget');
    let reads = 0;
    driveLookupFor.mockImplementation((_e: unknown, _s: unknown, opts: { cacheOnly?: boolean; onBilled?: () => void }) => {
      return async () => {
        reads += 1;
        if (opts?.cacheOnly !== true) opts?.onBilled?.();
        return { minutes: 20 };
      };
    });

    // WEEKDAYS only and SANDWICHED candidates, and both matter. A weekend has no windows, so its
    // candidates never reach a lookup and pad the day count without adding a read. A candidate
    // with one neighbour reads one leg; one with a job either side reads three. Twelve weekdays at
    // three legs is 36 uncapped, comfortably over the budget of 24 — if the arrangement cannot
    // exceed the bound, the assertion proves nothing about whether the bound is enforced.
    const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08',
                  '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16'];
    await scoreOfferedSlots({
      ...base,
      ...noBase,
      sessionId: null,
      slots: days.map((d) => ({ start: utc(d, '14:00').toISOString(), end: utc(d, '15:00').toISOString() })),
      requestable: [],
      neighbours: days.flatMap((d) => [neighbour(d, '13:00', 1), neighbour(d, '16:30', 2)]),
    });

    expect(reads).toBeGreaterThan(0);

    expect(reads).toBeLessThanOrEqual(GROUPING_LEG_BUDGET);
  });

  it('holds the read bound even when every leg THROWS', async () => {
    // `scoreCandidates` debits its own leg counter only AFTER the three lookups return, so a leg
    // that throws leaves it undebited and waves the next candidate through. The bound has to live
    // at the lookup itself or it is a hope rather than a fact.
    const { GROUPING_LEG_BUDGET } = await import('../../booking/travel/grouping-budget');
    let reads = 0;
    // Throws on the LAST leg of each candidate, not the first. Throwing immediately means only
    // one leg is read per candidate and the arrangement never approaches the bound; the case that
    // matters is a candidate that reads all three and then leaves the counter undebited.
    driveLookupFor.mockImplementation(() => async (leg: { from: { lat: number }; to: { lat: number } }) => {
      reads += 1;
      const isBaseline = leg.from.lat !== 51.5 && leg.to.lat !== 51.5;
      if (isBaseline) throw new Error('router down');
      return { minutes: 20 };
    });

    // TWENTY candidates on ONE day, all sandwiched, so the undebited counter is what decides.
    // Spread across days it would not discriminate: one candidate per day never gives the
    // within-day counter a second candidate to wave through, and the per-day budget shrinks on
    // its own. Sixty legs uncapped against a budget of 24.
    const day = '2026-09-01';
    const starts = Array.from({ length: 20 }, (_, i) => 14 * 60 + i);
    const at = (mins: number) => new Date(Date.UTC(2026, 8, 1, Math.floor(mins / 60), mins % 60)).toISOString();

    await scoreOfferedSlots({
      ...base,
      ...noBase,
      sessionId: null,
      slots: starts.map((m) => ({ start: at(m), end: at(m + 30) })),
      requestable: [],
      neighbours: [neighbour(day, '13:00', 1), neighbour(day, '16:30', 2)],
    });

    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(GROUPING_LEG_BUDGET);
  });

  it('stops READING at the deadline, not merely stops waiting', async () => {
    // The race resolves the caller; it does not stop `runPass`, which carries on reading and
    // BUYING behind a customer who has already been answered. Money spent after the answer went
    // out is the worst version of an optional feature.
    const { GROUPING_DEADLINE_MS } = await import('../../booking/travel/grouping-budget');
    const startedAt = Date.now();
    let lastReadAt = 0;
    driveLookupFor.mockImplementation(() => async () => {
      lastReadAt = Date.now();
      await new Promise((r) => setTimeout(r, 300));
      return { minutes: 20 };
    });

    const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08',
                  '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16'];
    await scoreOfferedSlots({
      ...base,
      ...noBase,
      sessionId: null,
      slots: days.map((d) => ({ start: utc(d, '14:00').toISOString(), end: utc(d, '15:00').toISOString() })),
      requestable: [],
      neighbours: days.flatMap((d) => [neighbour(d, '13:00', 1), neighbour(d, '16:30', 2)]),
    });

    // Let the abandoned pass run on. Nothing more may be read once the deadline has gone by.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(lastReadAt - startedAt).toBeLessThanOrEqual(GROUPING_DEADLINE_MS + 400);
  }, 20_000);

  it('estimates an adjacent leg the gate never routed, which is the CHEAP side', async () => {
    // The gap this closes bites in exactly the wrong place. A leg the gate did not route is
    // usually one it did not need to - the bounds cleared the slot on their own - and that happens
    // when the two points are CLOSE. So the unmeasured legs are the short, cheap insertions, which
    // are the whole reason to prefer a slot. Measured live: a customer beside an existing job
    // scored `leg_unmeasured` while the expensive alternative across the province scored fine.
    driveLookupFor.mockReturnValue(async () => ({ minutes: null, cause: 'not_cached' }));

    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      sessionId: null,
      slots: [slot(MON, '10:00')],
      requestable: [],
      neighbours: [neighbour(MON, '09:00', 51.49)],
    });

    const scored = result!.scores[utc(MON, '10:00').toISOString()];
    expect(scored.neutralReason).toBeNull();
    expect(scored.costMinutes).not.toBeNull();
    // ...and the offer says how much of itself rests on an estimate rather than a measurement.
    expect(result!.estimatedLegs).toBeGreaterThan(0);
  });

  it('never estimates a BASELINE leg, only the ones beside the candidate', async () => {
    // The baseline is the counterfactual the whole cost is measured against. Estimating it would
    // subtract a guess from two real numbers and call the difference a cost.
    let baselineAsked = 0;
    driveLookupFor.mockImplementation(() => async (leg: { from: { lat: number }; to: { lat: number } }) => {
      const isBaseline = leg.from.lat !== 51.5 && leg.to.lat !== 51.5;
      if (isBaseline) baselineAsked += 1;
      return { minutes: null, cause: 'not_cached' };
    });

    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      sessionId: null,
      slots: [{ start: utc(MON, '14:00').toISOString(), end: utc(MON, '15:00').toISOString() }],
      requestable: [],
      neighbours: [neighbour(MON, '13:00', 51.49), neighbour(MON, '16:30', 51.48)],
    });

    expect(baselineAsked).toBeGreaterThan(0);
    // The baseline came back null and was NOT estimated, so the candidate carries no opinion.
    const scored = result!.scores[utc(MON, '14:00').toISOString()];
    expect(scored.costMinutes).toBeNull();
    expect(scored.neutralReason).toBe('leg_unmeasured');
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

describe('grouping anchors on confirmed bookings alone', () => {
  it('does NOT let a pending booking anchor a group', async () => {
    // Feasibility counts a pending booking: it occupies the day, and offering a slot on top of it
    // would double-book. Grouping must NOT, because grouping claims the owner is ALREADY working
    // near there, and a booking nobody has agreed to is not evidence anybody is going anywhere.
    //
    // Stated in CONTEXT.md, in ADR-0017 and in insertion-scorer's own doc comment, and enforced
    // nowhere until now. It read as correct only because no code path writes a `pending` row - so
    // the suite could never have caught it, which is precisely why this test constructs one.
    driveLookupFor.mockReturnValue(async () => ({ minutes: 20 }));

    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      slots: [{ start: utc(MON, '14:00').toISOString(), end: utc(MON, '15:00').toISOString() }],
      requestable: [],
      neighbours: [neighbour(MON, '13:00', 1, 'pending')],
    });

    expect(result!.scores[utc(MON, '14:00').toISOString()].costMinutes).toBeNull();
  });

  it('DOES let a confirmed booking anchor a group', async () => {
    // The control: the same diary, the same times, one word different.
    driveLookupFor.mockReturnValue(async () => ({ minutes: 20 }));

    const result = await scoreOfferedSlots({
      ...base,
      ...noBase,
      slots: [{ start: utc(MON, '14:00').toISOString(), end: utc(MON, '15:00').toISOString() }],
      requestable: [],
      neighbours: [neighbour(MON, '13:00', 1, 'confirmed')],
    });

    expect(result!.scores[utc(MON, '14:00').toISOString()].costMinutes).toBe(20);
  });
});
