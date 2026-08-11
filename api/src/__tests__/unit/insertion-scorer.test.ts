/**
 * #81 (LP4) - what one extra job costs the owner's half-day.
 *
 * The contract calls this out as the surface where "two correct-looking scorers would disagree",
 * so these are written as the RULES rather than as paths through the code. Each one is a way the
 * scorer could look right and steer an owner wrong - and steering is silent: nothing errors, the
 * day just scatters.
 *
 * ADR-0017 governs throughout: grouping prefers a Slot, it never refuses one. No test here should
 * ever be able to show a Slot removed, downgraded, or turned into a Request.
 */
import { describe, it, expect } from 'vitest';
import { scoreCandidates, type LegLookup, type RouteNode } from '../../booking/travel/insertion-scorer';
import { resolveDayPeriods, periodOf } from '../../booking/travel/half-day';

const TZ = 'Europe/Brussels';
const DAY = '2026-09-07'; // a Monday
/**
 * UTC, deliberately - these are instants, and the period boundary is one too.
 *
 * The day is 08:00-18:00 Brussels, so the clock midpoint is 13:00 local = 11:00Z. Everything the
 * morning tests use sits strictly before 11:00Z. Writing "11:00" here meaning eleven in the
 * morning put an anchor exactly ON the boundary, where it counts as afternoon and vanishes from
 * the morning's neighbours - which is how the first run of this file failed.
 */
const at = (hhmm: string) => new Date(`2026-09-07T${hhmm}:00.000Z`);
const P = (n: number) => ({ lat: 51 + n / 100, lng: 3 + n / 100 });

const periods = resolveDayPeriods({
  localDay: DAY,
  timezone: TZ,
  windows: [{ start: '08:00', end: '18:00' }],
  alwaysOpen: false,
})!;

const anchor = (from: string, to: string, p: number): RouteNode => ({
  blockedStart: at(from),
  blockedEnd: at(to),
  point: P(p),
});

const candidate = (from: string, to: string, p: number | null) => ({
  blockedStart: at(from),
  blockedEnd: at(to),
  point: p === null ? null : P(p),
});

/** A lookup with fixed answers per ordered pair, and a record of what it was asked. */
function lookupOf(table: Record<string, number | null>) {
  const calls: Array<{ key: string; departAt: string }> = [];
  const fn: LegLookup = async (a, b, departAt) => {
    const key = `${a.lat.toFixed(2)}->${b.lat.toFixed(2)}`;
    calls.push({ key, departAt: departAt.toISOString() });
    return key in table ? table[key] : 10;
  };
  return { fn, calls };
}

const big = { legBudget: 100, deadline: Date.now() + 60_000 };

describe('the formula', () => {
  it('is the detour, not the drive: t(prev->c) + t(c->next) - t(prev->next)', async () => {
    // The subtraction is the whole idea. Without it a candidate between two far-apart jobs looks
    // expensive when it is nearly free - the owner was making that drive anyway.
    const { fn } = lookupOf({ '51.01->51.02': 30, '51.02->51.03': 30, '51.01->51.03': 50 });
    const [scored] = await scoreCandidates({
      candidates: [candidate('08:00', '08:30', 2)],
      anchors: [anchor('07:00', '07:30', 1), anchor('09:00', '09:30', 3)],
      periods,
      base: null,
      maxDetourMin: null,
      lookup: fn,
      ...big,
    });
    // 30 + 30 - 50 = 10 added minutes, not 60.
    expect(scored.costMinutes).toBe(10);
    expect(scored.preferred).toBe(true);
  });

  it('drops the missing term at each edge rather than inventing one', async () => {
    const { fn } = lookupOf({ '51.02->51.03': 25 });
    const [first] = await scoreCandidates({
      candidates: [candidate('08:30', '09:00', 2)],
      anchors: [anchor('09:00', '09:30', 3)],
      periods,
      base: null,
      maxDetourMin: null,
      lookup: fn,
      ...big,
    });
    // No `prev`, so no `prev->candidate` and no baseline to subtract: the cost is the one leg.
    expect(first.costMinutes).toBe(25);
  });

  it('departs at fixed instants, or the same day scores differently twice', async () => {
    // Traffic-aware answers are departure-bucketed. A scorer free to choose departures would make
    // ranking unstable, and ranking stability is LP4's own gate.
    const { fn, calls } = lookupOf({});
    await scoreCandidates({
      candidates: [candidate('08:00', '08:30', 2)],
      anchors: [anchor('07:00', '07:30', 1), anchor('09:00', '09:30', 3)],
      periods,
      base: null,
      maxDetourMin: null,
      lookup: fn,
      ...big,
    });
    const departures = calls.map((c) => `${c.key}@${c.departAt.slice(11, 16)}`);
    expect(departures).toEqual([
      '51.01->51.02@07:30', // prev -> candidate, departing when prev's block ends
      '51.02->51.03@08:30', // candidate -> next, departing when the candidate's block ends
      '51.01->51.03@07:30', // the baseline, departing at the same instant as the first leg
    ]);
  });
});

describe('the Home Base is a start, never a return', () => {
  const base = { point: P(0), departAt: at('06:00') };

  it('precedes only the first constraining job of the whole day', async () => {
    const { fn } = lookupOf({ '51.00->51.02': 15, '51.02->51.03': 20, '51.00->51.03': 25 });
    const [scored] = await scoreCandidates({
      candidates: [candidate('08:30', '09:00', 2)],
      anchors: [anchor('09:00', '09:30', 3)],
      periods,
      base,
      maxDetourMin: null,
      lookup: fn,
      ...big,
    });
    expect(scored.costMinutes).toBe(10); // 15 + 20 - 25
  });

  it('does not precede a candidate that already has a job before it', async () => {
    const { fn, calls } = lookupOf({});
    await scoreCandidates({
      candidates: [candidate('08:00', '08:30', 2)],
      anchors: [anchor('07:00', '07:30', 1)],
      periods,
      base,
      maxDetourMin: null,
      lookup: fn,
      ...big,
    });
    // Every leg starts from the 09:00 job, never from the premises.
    expect(calls.every((c) => !c.key.startsWith('51.00'))).toBe(true);
  });

  it('does not precede an AFTERNOON candidate just because its period is empty', async () => {
    // The case the day-first guard actually protects, and the one a mutation showed my other
    // tests were not reaching. This candidate has no anchor before it IN ITS OWN PERIOD, so a
    // naive scorer reaches for the Base - but the owner is not leaving home at 14:00, they are
    // driving from the morning job. Treating it as a departure from the premises would score
    // every empty afternoon as though the day restarted at lunch.
    const { fn, calls } = lookupOf({});
    const [scored] = await scoreCandidates({
      candidates: [candidate('12:00', '12:30', 2)],
      anchors: [anchor('07:00', '07:30', 1)], // morning only
      periods,
      base,
      maxDetourMin: null,
      lookup: fn,
      ...big,
    });
    // Nothing measured from the premises, and with no afternoon neighbour there is no preference
    // to express at all.
    expect(calls.some((c) => c.key.startsWith('51.00'))).toBe(false);
    expect(scored).toMatchObject({ costMinutes: null, neutralReason: 'unanchored' });
  });

  it('is never a NEXT - start-from-base says nothing about going home', async () => {
    // The most tempting wrong addition: a return leg would make late slots look expensive and
    // quietly bias every afternoon toward finishing near the premises, which nobody asked for.
    const { fn, calls } = lookupOf({});
    await scoreCandidates({
      candidates: [candidate('14:00', '14:30', 2)],
      anchors: [anchor('07:00', '07:30', 1)],
      periods,
      base,
      maxDetourMin: null,
      lookup: fn,
      ...big,
    });
    expect(calls.some((c) => c.key.endsWith('->51.00'))).toBe(false);
  });
});

describe('when the scorer must say nothing at all', () => {
  const anchors = [anchor('07:00', '07:30', 1), anchor('09:00', '09:30', 3)];

  it('an unanchored period is NEUTRAL, not all-preferred', async () => {
    // "All equally preferred" would rank an empty afternoon above a morning that genuinely
    // clusters. A period with nothing in it has nothing to be near.
    const { fn } = lookupOf({});
    const [scored] = await scoreCandidates({
      candidates: [candidate('12:00', '12:30', 2)],
      anchors: [anchor('07:00', '07:30', 1)],
      periods,
      base: null,
      maxDetourMin: null,
      lookup: fn,
      ...big,
    });
    expect(scored).toMatchObject({ costMinutes: null, preferred: null, neutralReason: 'unanchored' });
  });

  it('a candidate straddling the boundary belongs to NEITHER period', async () => {
    // Not "the one it mostly occupies" - a job running through lunch is not a morning job, and
    // preferring it as one clusters the morning around something that is not in it.
    const { fn } = lookupOf({});
    const [scored] = await scoreCandidates({
      candidates: [candidate('10:45', '11:15', 2)],
      anchors,
      periods,
      base: null,
      maxDetourMin: null,
      lookup: fn,
      ...big,
    });
    expect(scored.neutralReason).toBe('straddles_boundary');
    expect(scored.period).toBeNull();
  });

  it('an untrusted position cannot call a drive efficient', async () => {
    // ADR-0014: a coarse position may refuse a drive and may never clear one. Preference is a
    // kind of clearing.
    const { fn } = lookupOf({});
    const [scored] = await scoreCandidates({
      candidates: [candidate('10:00', '10:30', null)],
      anchors,
      periods,
      base: null,
      maxDetourMin: null,
      lookup: fn,
      ...big,
    });
    expect(scored.neutralReason).toBe('position_not_trusted');
  });

  it('an unmeasurable leg gives NO score rather than a partial one', async () => {
    const { fn } = lookupOf({ '51.02->51.03': null });
    const [scored] = await scoreCandidates({
      candidates: [candidate('08:00', '08:30', 2)],
      anchors,
      periods,
      base: null,
      maxDetourMin: null,
      lookup: fn,
      ...big,
    });
    expect(scored).toMatchObject({ costMinutes: null, neutralReason: 'leg_unmeasured' });
  });

  it('a spent budget leaves the rest neutral, and turns nothing into a Request', async () => {
    // The rule ADR-0017 turns on. Grouping is optional; it must degrade to silence, never to a
    // worse answer for the customer.
    const { fn } = lookupOf({});
    const scored = await scoreCandidates({
      candidates: [candidate('08:00', '08:30', 2), candidate('08:30', '09:00', 2)],
      anchors,
      periods,
      base: null,
      maxDetourMin: null,
      lookup: fn,
      legBudget: 3, // exactly one candidate's worth
      deadline: Date.now() + 60_000,
    });
    expect(scored[0].costMinutes).not.toBeNull();
    expect(scored[1]).toMatchObject({ costMinutes: null, neutralReason: 'leg_unmeasured' });
    // Neither is removed, and neither carries anything that could change its feasibility class.
    expect(scored).toHaveLength(2);
  });

  it('a day with no periods scores nothing', async () => {
    const { fn } = lookupOf({});
    const [scored] = await scoreCandidates({
      candidates: [candidate('08:00', '08:30', 2)],
      anchors,
      periods: null,
      base: null,
      maxDetourMin: null,
      lookup: fn,
      ...big,
    });
    expect(scored.neutralReason).toBe('no_periods');
  });
});

describe('the threshold only withholds a preference', () => {
  const anchors = [anchor('07:00', '07:30', 1), anchor('09:00', '09:30', 3)];
  const table = { '51.01->51.02': 30, '51.02->51.03': 30, '51.01->51.03': 50 }; // cost 10

  it('prefers a candidate exactly AT the threshold', async () => {
    const { fn } = lookupOf(table);
    const [scored] = await scoreCandidates({
      candidates: [candidate('08:00', '08:30', 2)],
      anchors, periods, base: null, maxDetourMin: 10, lookup: fn, ...big,
    });
    expect(scored.preferred).toBe(true);
  });

  it('over the threshold is UNPREFERRED, still scored, still offered', async () => {
    // Not neutral and not removed: the Slot keeps its feasibility class and stays confirmable. The
    // only thing withheld is the preference.
    const { fn } = lookupOf(table);
    const [scored] = await scoreCandidates({
      candidates: [candidate('08:00', '08:30', 2)],
      anchors, periods, base: null, maxDetourMin: 9, lookup: fn, ...big,
    });
    expect(scored).toMatchObject({ costMinutes: 10, preferred: false, neutralReason: null });
  });
});

describe('determinism', () => {
  it('scores the same diary identically however the anchors arrive', async () => {
    // LP4's gate is ranking stability. Input order is not guaranteed - a query without an ORDER BY
    // can permute between runs - so the scorer sorts rather than trusting it.
    const table = { '51.01->51.02': 30, '51.02->51.03': 30, '51.01->51.03': 50 };
    const forward = [anchor('07:00', '07:30', 1), anchor('09:00', '09:30', 3)];
    const run = (anchors: RouteNode[]) =>
      scoreCandidates({
        candidates: [candidate('08:00', '08:30', 2)],
        anchors, periods, base: null, maxDetourMin: null, lookup: lookupOf(table).fn, ...big,
      });
    const a = await run(forward);
    const b = await run([...forward].reverse());
    expect(a[0].costMinutes).toBe(b[0].costMinutes);
  });
});

describe('the half-day boundary itself', () => {
  it('is the clock midpoint of the day, not of the open hours', async () => {
    // 08:00-10:00 and 14:00-18:00: six open hours whose midpoint is 16:00, which nobody calls the
    // start of their afternoon. The clock midpoint of 08:00-18:00 is 13:00.
    const p = resolveDayPeriods({
      localDay: DAY, timezone: TZ, alwaysOpen: false,
      windows: [{ start: '08:00', end: '10:00' }, { start: '14:00', end: '18:00' }],
    })!;
    expect(p.boundary.toISOString()).toBe('2026-09-07T11:00:00.000Z'); // 13:00 Brussels
  });

  it('suggests the widest gap without applying it', async () => {
    // Two windows may be a school run rather than a morning and an afternoon, and only the owner
    // knows which.
    const p = resolveDayPeriods({
      localDay: DAY, timezone: TZ, alwaysOpen: false,
      windows: [{ start: '08:00', end: '10:00' }, { start: '14:00', end: '18:00' }],
    })!;
    expect(p.suggested?.toISOString()).toBe('2026-09-07T10:00:00.000Z'); // 12:00 Brussels
    expect(p.boundary).not.toEqual(p.suggested);
  });

  it('does not run at all on an always-open day', async () => {
    // A day with no shape has no midpoint, and 12:00 would be an invention the owner never made.
    expect(resolveDayPeriods({ localDay: DAY, timezone: TZ, alwaysOpen: true, windows: [{ start: '00:00', end: '23:59' }] })).toBeNull();
  });

  it('does not run on a closed day', async () => {
    expect(resolveDayPeriods({ localDay: DAY, timezone: TZ, alwaysOpen: false, windows: [] })).toBeNull();
  });

  it('honours an owner override, and ignores one outside the day', async () => {
    const inside = resolveDayPeriods({
      localDay: DAY, timezone: TZ, alwaysOpen: false,
      windows: [{ start: '08:00', end: '18:00' }], boundaryOverride: '11:00',
    })!;
    expect(inside.boundary.toISOString()).toBe('2026-09-07T09:00:00.000Z');

    // An override before opening would put every Slot in the afternoon and silently disable
    // grouping - a configuration mistake that should not look like a working setting.
    const outside = resolveDayPeriods({
      localDay: DAY, timezone: TZ, alwaysOpen: false,
      windows: [{ start: '08:00', end: '18:00' }], boundaryOverride: '05:00',
    })!;
    expect(outside.boundary.toISOString()).toBe('2026-09-07T11:00:00.000Z'); // fell back to midday
  });

  it('puts the boundary instant itself in the afternoon', async () => {
    // Stated because half-open at both ends leaves an instant in neither period, and closed at
    // both puts it in two.
    const p = resolveDayPeriods({ localDay: DAY, timezone: TZ, alwaysOpen: false, windows: [{ start: '08:00', end: '18:00' }] })!;
    expect(periodOf({ start: p.boundary, end: new Date(p.boundary.getTime() + 1800_000) }, p)).toBe('afternoon');
    expect(periodOf({ start: new Date(p.boundary.getTime() - 1800_000), end: p.boundary }, p)).toBe('morning');
  });
});

describe('full-day grouping widens what a candidate is compared against', () => {
  /**
   * The difference in one sentence: an AFTERNOON candidate priced against a MORNING job.
   *
   * Under half-day grouping the morning's jobs are simply not in the afternoon's anchor list, so
   * an afternoon slot next to a morning job scores `unanchored` - the van's position at 11:00
   * tells you nothing about a 14:00 slot, as far as the half-day view is concerned. Full day says
   * it does, and that is the whole of the feature.
   */
  const DAY = '2026-09-07';
  const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00.000Z`);

  const periods = resolveDayPeriods({
    localDay: DAY,
    timezone: 'UTC',
    windows: [{ start: '08:00', end: '18:00' }],
    alwaysOpen: false,
  })!;

  // One job, in the MORNING. The candidate sits in the afternoon.
  const anchors = [
    { blockedStart: at('09:00'), blockedEnd: at('10:00'), point: { lat: 51.2, lng: 4.4 } },
  ];
  const candidates = [
    { blockedStart: at('14:00'), blockedEnd: at('15:00'), point: { lat: 51.25, lng: 4.45 } },
  ];

  const run = (groupWholeDay: boolean) =>
    scoreCandidates({
      candidates,
      anchors,
      periods,
      base: null,
      maxDetourMin: null,
      lookup: async () => 20,
      legBudget: 99,
      deadline: Date.now() + 60_000,
      groupWholeDay,
    });

  it('half day: an afternoon candidate cannot see a morning job', async () => {
    const [scored] = await run(false);
    expect(scored.costMinutes).toBeNull();
    expect(scored.neutralReason).toBe('unanchored');
  });

  it('full day: the same candidate IS priced against that morning job', async () => {
    const [scored] = await run(true);
    expect(scored.costMinutes).toBe(20);
  });

  it('still records the slot’s own half, because widening the comparison does not move the slot', async () => {
    // `period` labels WHEN the slot is, not what it was compared against. An afternoon slot is an
    // afternoon slot however widely it was scored, and the offer record means the same thing in
    // both modes.
    const [scored] = await run(true);
    expect(scored.period).toBe('afternoon');
  });
});

describe('an always-open diary has no halves, which only stops HALF-day grouping', () => {
  /**
   * `resolveDayPeriods` returns null when a business is always open, because a day with no
   * opening hours has no clock midpoint to split on. Half-day grouping genuinely cannot work
   * there. A WHOLE day needs no split, so full-day grouping can - and the plan said so.
   *
   * It did not, until this test. The `no_periods` short-circuit ran BEFORE `groupWholeDay` was
   * read, so a stored `full_day` was silently ignored on exactly the diary shape it was meant to
   * answer for: the owner picks the option, nothing changes, and the platform is doing something
   * other than what it says.
   */
  const DAY = '2026-09-07';
  const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00.000Z`);

  const anchors = [
    { blockedStart: at('09:00'), blockedEnd: at('10:00'), point: { lat: 51.2, lng: 4.4 } },
  ];
  const candidates = [
    { blockedStart: at('14:00'), blockedEnd: at('15:00'), point: { lat: 51.25, lng: 4.45 } },
  ];

  const run = (groupWholeDay: boolean) =>
    scoreCandidates({
      candidates,
      anchors,
      // What an always-open business produces.
      periods: null,
      base: null,
      maxDetourMin: null,
      lookup: async () => 20,
      legBudget: 99,
      deadline: Date.now() + 60_000,
      groupWholeDay,
    });

  it('half day still cannot score it, and says why', async () => {
    const [scored] = await run(false);
    expect(scored.costMinutes).toBeNull();
    expect(scored.neutralReason).toBe('no_periods');
  });

  it('full day DOES score it', async () => {
    const [scored] = await run(true);
    expect(scored.costMinutes).toBe(20);
  });

  it('records no period, because there genuinely is not one', async () => {
    // Not 'morning' by default: an always-open day has no halves, and claiming one would put a
    // fiction on the offer record.
    const [scored] = await run(true);
    expect(scored.period).toBeNull();
  });
});
