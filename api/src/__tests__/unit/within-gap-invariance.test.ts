/**
 * When two candidates in the same gap cost the same, and when they do not.
 *
 * I claimed this was arithmetic: `cost = t(prev→c) + t(c→next) − t(prev→next)` carries no
 * candidate-time term, so every slot between the same two anchors scores identically. An
 * independent review pushed back, and it was right — the claim is true only for a travel model
 * whose durations do not depend on WHEN you set off.
 *
 * The middle term takes the candidate's OWN end instant as its departure (`insertion-scorer.ts`,
 * `fromCandidate`), so under traffic-aware routing it varies per candidate and the costs separate.
 *
 * That distinction decided how a whole measurement should be read. Two live sweeps found almost no
 * within-gap variation and concluded the opportunity was rare — but every booking in them was days
 * or weeks ahead, and `routes.service` only asks for traffic inside a 24-hour horizon, bucketing
 * everything beyond it to one constant. The sweeps measured the invariant regime by construction
 * and could not have found variation. Pinned here so the next reader does not repeat it.
 */
import { describe, it, expect } from 'vitest';
import { scoreCandidates, type LegLookup } from '../../booking/travel/insertion-scorer';
import { resolveDayPeriods } from '../../booking/travel/half-day';

const DAY = '2026-09-07';
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00.000Z`);

const periods = resolveDayPeriods({
  localDay: DAY,
  timezone: 'UTC',
  windows: [{ start: '08:00', end: '18:00' }],
  alwaysOpen: false,
})!;

/** Two anchors with a wide morning gap, and three candidates sitting inside it. */
const anchors = [
  { blockedStart: at('08:00'), blockedEnd: at('08:30'), point: { lat: 51.2, lng: 4.4 } },
  { blockedStart: at('12:00'), blockedEnd: at('12:30'), point: { lat: 51.3, lng: 4.5 } },
];
const candidates = ['09:00', '10:00', '11:00'].map((t) => ({
  blockedStart: at(t),
  blockedEnd: new Date(at(t).getTime() + 30 * 60_000),
  point: { lat: 51.25, lng: 4.45 },
}));

const score = (lookup: LegLookup) =>
  scoreCandidates({
    candidates,
    anchors,
    periods,
    base: null,
    maxDetourMin: null,
    lookup,
    legBudget: 99,
    deadline: Date.now() + 60_000,
  });

describe('within-gap cost invariance', () => {
  it('HOLDS when durations do not depend on departure time', () => {
    // The regime every live measurement so far ran in: beyond the 24-hour traffic horizon,
    // `departureBucket` collapses to a constant and every candidate reads one cached duration.
    const constant: LegLookup = async () => 20;

    return score(constant).then((scored) => {
      const costs = scored.map((s) => s.costMinutes);
      expect(costs).toEqual([20, 20, 20]);
      expect(new Set(costs).size).toBe(1);
    });
  });

  it('BREAKS when the candidate→next leg depends on when the van leaves', async () => {
    // Traffic-aware routing, which is what a same-day or next-day booking actually gets. Only the
    // middle term moves: `prev→candidate` and the `prev→next` baseline both depart at the previous
    // job's end, which is fixed for the whole gap.
    const byDeparture: LegLookup = async (_from, _to, departAt) => {
      const hour = departAt.getUTCHours();
      // A rush-hour shoulder: leaving later out of this gap is slower.
      return 20 + (hour >= 11 ? 25 : hour >= 10 ? 10 : 0);
    };

    const scored = await score(byDeparture);
    const costs = scored.map((s) => s.costMinutes);

    expect(new Set(costs).size).toBeGreaterThan(1);
    // The 09:00 candidate leaves its own slot at 09:30 and is cheapest; the 11:00 one leaves at
    // 11:30 into the slow band and is dearest. That spread is exactly what steering acts on.
    expect(costs[0]).toBeLessThan(costs[2]!);
  });

  it('is the SAME cost whichever slot you pick, when only the anchors are asked about', async () => {
    // A sharper statement of the first case: the two fixed terms are literally the same two
    // lookups for every candidate, so a model that ignores departure time cannot separate them
    // however far apart the candidates sit in the gap.
    const seen: string[] = [];
    const constant: LegLookup = async (from, to, departAt) => {
      seen.push(`${from.lat}->${to.lat}@${departAt.toISOString().slice(11, 16)}`);
      return 15;
    };

    await score(constant);

    // `prev→next` is asked with the same departure every time — one distinct baseline leg.
    const baselines = seen.filter((s) => s.startsWith('51.2->51.3'));
    expect(new Set(baselines).size).toBe(1);
  });
});
