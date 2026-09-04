import { describe, it, expect } from 'vitest';
import {
  estimateDrive,
  precedingNeighbour,
  followingNeighbour,
  type TravelNeighbour,
  type TravelCandidate,
  assessSlotRouted,
  routeBudget,
  replayLookup,
  withBaseNeighbour,
  selectFirstJob,
  type RoutableLeg,
} from '../../booking/travel/travel-gate';
import type { GeoPoint } from '../../contracts/travel';

/** Real Belgian coordinates, so every distance below is checkable against a map. */
const BRUSSELS: GeoPoint = { lat: 50.8503, lng: 4.3517 };
const GHENT: GeoPoint = { lat: 51.0543, lng: 3.7174 }; // ~47 km from Brussels
const LIEGE: GeoPoint = { lat: 50.6326, lng: 5.5797 }; // ~87 km from Brussels
const NEXT_DOOR: GeoPoint = { lat: 50.8504, lng: 4.3518 }; // metres from Brussels
/**
 * ~2 km from Brussels. Sized against `PREFILTER_MIN_KMH`, which is a crawl by design: the
 * floor clears 1 km in an hour and 2.5 km in 2.5 hours, so this is a pair whose verdict
 * genuinely turns on how wide the window is rather than on how far apart the jobs are.
 */
const ACROSS_TOWN: GeoPoint = { lat: 50.8680, lng: 4.3520 };

const at = (iso: string): Date => new Date(iso);

const candidate = (input: {
  start: string;
  end: string;
  point?: GeoPoint;
  coarse?: boolean;
}): TravelCandidate => ({
  blockedStart: at(input.start),
  blockedEnd: at(input.end),
  point: input.point ?? BRUSSELS,
  coarse: input.coarse ?? false,
});

const known = (start: string, end: string, point: GeoPoint): TravelNeighbour => ({
  blockedStart: at(start),
  blockedEnd: at(end),
  location: { kind: 'known', point },
});

const coarse = (start: string, end: string, point: GeoPoint): TravelNeighbour => ({
  blockedStart: at(start),
  blockedEnd: at(end),
  location: { kind: 'coarse', point },
});

const locationless = (start: string, end: string): TravelNeighbour => ({
  blockedStart: at(start),
  blockedEnd: at(end),
  location: { kind: 'locationless' },
});

const unresolved = (start: string, end: string): TravelNeighbour => ({
  blockedStart: at(start),
  blockedEnd: at(end),
  location: { kind: 'unresolved' },
});

/**
 * The bounds-only verdict — what `assessSlotRouted` reduces to when routing answers nothing.
 *
 * The synchronous `assessTravel`/`assessSlot` used to be exported for this, and were removed:
 * they were a live entry point that skipped routing without saying so. A replay lookup over an
 * empty snapshot is the same behaviour, stated rather than implied, and it is exactly what the
 * in-lock assert does in production.
 */
const boundsVerdict = async (input: {
  candidate: TravelCandidate;
  before?: TravelNeighbour | null;
  after?: TravelNeighbour | null;
  minGapMin: number;
  maxTravelMin?: number | null;
}) =>
  (
    await assessSlotRouted({
      candidate: input.candidate,
      neighbours: [input.before, input.after].filter((n): n is TravelNeighbour => !!n),
      minGapMin: input.minGapMin,
      maxTravelMin: input.maxTravelMin ?? null,
      lookup: replayLookup({}),
    })
  ).verdict;

const slotVerdict = async (input: {
  candidate: TravelCandidate;
  neighbours: TravelNeighbour[];
  minGapMin: number;
  maxTravelMin?: number | null;
}) => (await assessSlotRouted({ ...input, maxTravelMin: input.maxTravelMin ?? null, lookup: replayLookup({}) })).verdict;

describe('assessTravel — the certain no', () => {
  it('refuses a slot whose preceding job cannot possibly be left in time', async () => {
    // Liège→Brussels is ~87 km straight line. A 10-minute gap covers 20 km at motorway
    // speed. Not even a helicopter fits.
    const verdict = await boundsVerdict({
      candidate: candidate({ start: '2026-09-01T10:10:00Z', end: '2026-09-01T11:00:00Z' }),
      before: known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', LIEGE),
      after: null,
      minGapMin: 0,
      maxTravelMin: null,
    });
    expect(verdict).toBe('unreachable');
  });

  it('refuses on the FOLLOWING side too — the drive out is as real as the drive in', async () => {
    const verdict = await boundsVerdict({
      candidate: candidate({ start: '2026-09-01T09:00:00Z', end: '2026-09-01T10:00:00Z' }),
      before: null,
      after: known('2026-09-01T10:10:00Z', '2026-09-01T11:00:00Z', LIEGE),
      minGapMin: 0,
      maxTravelMin: null,
    });
    expect(verdict).toBe('unreachable');
  });

  it('spends the slack before the drive, so a big margin can make a short hop impossible', async () => {
    // 60 minutes of gap, but 58 of them are the owner's own margin: 2 minutes left, and
    // 47 km does not fit in 2 minutes.
    const verdict = await boundsVerdict({
      candidate: candidate({ start: '2026-09-01T11:00:00Z', end: '2026-09-01T12:00:00Z' }),
      before: known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', GHENT),
      after: null,
      minGapMin: 58,
    });
    expect(verdict).toBe('unreachable');
  });
});

describe('assessTravel — the certain yes', () => {
  it('clears two jobs a few doors apart', async () => {
    const verdict = await boundsVerdict({
      candidate: candidate({ start: '2026-09-01T10:30:00Z', end: '2026-09-01T11:00:00Z', point: NEXT_DOOR }),
      before: known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', BRUSSELS),
      after: null,
      minGapMin: 5,
    });
    expect(verdict).toBe('clear');
  });

  it('clears an empty day', async () => {
    expect(
      await boundsVerdict({
        candidate: candidate({ start: '2026-09-01T10:00:00Z', end: '2026-09-01T11:00:00Z' }),
        before: null,
        after: null,
        minGapMin: 15,
      })
    ).toBe('clear');
  });
});

describe('assessTravel — the undecided middle', () => {
  it('cannot settle a pair between the two bounds', async () => {
    // Ghent→Brussels is ~47 km. A 60-minute gap covers 120 km at motorway speed (so it
    // could fit) but only 20 km at the pessimistic crawl (so it is not proven to fit).
    const verdict = await boundsVerdict({
      candidate: candidate({ start: '2026-09-01T11:00:00Z', end: '2026-09-01T12:00:00Z' }),
      before: known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', GHENT),
      after: null,
      minGapMin: 0,
      maxTravelMin: null,
    });
    expect(verdict).toBe('undecided');
  });

  it('lets an impossible side override an undecided one', async () => {
    const verdict = await boundsVerdict({
      candidate: candidate({ start: '2026-09-01T11:00:00Z', end: '2026-09-01T12:00:00Z' }),
      before: known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', GHENT), // undecided
      after: known('2026-09-01T12:05:00Z', '2026-09-01T13:00:00Z', LIEGE), // impossible
      minGapMin: 0,
      maxTravelMin: null,
    });
    expect(verdict).toBe('unreachable');
  });
});

describe('assessTravel — what a neighbour without coordinates means', () => {
  it('treats a locationless neighbour as no constraint at all', async () => {
    // A phone consultation. The owner could take it from the van, so the flat gap — which
    // was already applied before this function ran — is the whole rule.
    expect(
      await boundsVerdict({
        candidate: candidate({ start: '2026-09-01T10:05:00Z', end: '2026-09-01T11:00:00Z' }),
        before: locationless('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
        after: null,
        minGapMin: 0,
      maxTravelMin: null,
      })
    ).toBe('clear');
  });

  it('never clears past a neighbour whose location we merely FAILED to obtain', async () => {
    // The distinction that stops this feature silently confirming a drive nobody checked:
    // "has no location" and "we could not get its location" are opposite claims.
    expect(
      await boundsVerdict({
        candidate: candidate({ start: '2026-09-01T10:05:00Z', end: '2026-09-01T11:00:00Z' }),
        before: unresolved('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
        after: null,
        minGapMin: 0,
      maxTravelMin: null,
      })
    ).toBe('undecided');
  });
});

describe('assessTravel — coarse points may refuse, never clear', () => {
  it('lets a town-centre neighbour prove a drive impossible', async () => {
    expect(
      await boundsVerdict({
        candidate: candidate({ start: '2026-09-01T10:10:00Z', end: '2026-09-01T11:00:00Z' }),
        before: coarse('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', LIEGE),
        after: null,
        minGapMin: 0,
      maxTravelMin: null,
      })
    ).toBe('unreachable');
  });

  it('refuses to let a town-centre neighbour clear one, however close the dot looks', async () => {
    expect(
      await boundsVerdict({
        candidate: candidate({ start: '2026-09-01T10:30:00Z', end: '2026-09-01T11:00:00Z', point: NEXT_DOOR }),
        before: coarse('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', BRUSSELS),
        after: null,
        minGapMin: 0,
      maxTravelMin: null,
      })
    ).toBe('undecided');
  });

  it('refuses to clear a COARSE CANDIDATE even with no neighbours anywhere', async () => {
    // The rule the per-side logic cannot express on its own. An empty day would otherwise
    // auto-confirm a job at an address located only to a municipality, and stamp it checked.
    expect(
      await boundsVerdict({
        candidate: candidate({ start: '2026-09-01T10:00:00Z', end: '2026-09-01T11:00:00Z', coarse: true }),
        before: null,
        after: null,
        minGapMin: 0,
      maxTravelMin: null,
      })
    ).toBe('undecided');
  });

  it('refuses to clear a coarse candidate past locationless neighbours either', async () => {
    expect(
      await boundsVerdict({
        candidate: candidate({ start: '2026-09-01T10:05:00Z', end: '2026-09-01T11:00:00Z', coarse: true }),
        before: locationless('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
        after: locationless('2026-09-01T11:05:00Z', '2026-09-01T12:00:00Z'),
        minGapMin: 0,
      maxTravelMin: null,
      })
    ).toBe('undecided');
  });

  it('still refuses a coarse candidate that is provably too far', async () => {
    expect(
      await boundsVerdict({
        candidate: candidate({
          start: '2026-09-01T10:10:00Z',
          end: '2026-09-01T11:00:00Z',
          point: LIEGE,
          coarse: true,
        }),
        before: known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', BRUSSELS),
        after: null,
        minGapMin: 0,
      maxTravelMin: null,
      })
    ).toBe('unreachable');
  });
});

describe('neighbour selection', () => {
  const diary: TravelNeighbour[] = [
    known('2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z', BRUSSELS),
    known('2026-09-01T09:15:00Z', '2026-09-01T10:00:00Z', GHENT),
    known('2026-09-01T12:00:00Z', '2026-09-01T13:00:00Z', LIEGE),
    known('2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z', BRUSSELS),
  ];

  it('picks the LATEST job that finishes before the slot, not merely one of them', async () => {
    const before = precedingNeighbour(diary, { blockedStart: at('2026-09-01T11:00:00Z') });
    expect(before?.blockedEnd.toISOString()).toBe('2026-09-01T10:00:00.000Z');
  });

  it('picks the EARLIEST job that starts after the slot', async () => {
    const after = followingNeighbour(diary, { blockedEnd: at('2026-09-01T11:00:00Z') });
    expect(after?.blockedStart.toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });

  it('returns null on the empty sides of a diary', async () => {
    expect(precedingNeighbour(diary, { blockedStart: at('2026-09-01T07:00:00Z') })).toBeNull();
    expect(followingNeighbour(diary, { blockedEnd: at('2026-09-01T16:00:00Z') })).toBeNull();
  });

  it('ignores a job that overlaps the candidate — overlap is not travel s business', async () => {
    // 11:30 sits inside the 12:00-13:00 job's blocked range on neither side; the exclusion
    // constraint is what refuses a real overlap, and it did so before this ran.
    const overlapping = [known('2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z', LIEGE)];
    expect(precedingNeighbour(overlapping, { blockedStart: at('2026-09-01T11:30:00Z') })).toBeNull();
    expect(followingNeighbour(overlapping, { blockedEnd: at('2026-09-01T11:30:00Z') })).toBeNull();
  });

  it('LOOKS PAST a locationless job to the last place the owner had to be', async () => {
    // The bug this exists to stop: a Brussels job finishing at 10:00, a five-minute phone call
    // at 10:05, and a candidate in Liège at 10:15. If the phone call counts as the
    // predecessor it has no location, the side reads clear, and the gate has just confirmed
    // being in two cities fifteen minutes apart because a phone call stood in front of it.
    const diaryWithCall: TravelNeighbour[] = [
      known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', BRUSSELS),
      locationless('2026-09-01T10:05:00Z', '2026-09-01T10:10:00Z'),
    ];
    expect(
      precedingNeighbour(diaryWithCall, { blockedStart: at('2026-09-01T10:15:00Z') })?.location.kind
    ).toBe('known');
    expect(
      await slotVerdict({
        candidate: candidate({ start: '2026-09-01T10:15:00Z', end: '2026-09-01T11:00:00Z', point: LIEGE }),
        neighbours: diaryWithCall,
        minGapMin: 0,
      maxTravelMin: null,
      })
    ).toBe('unreachable');
  });

  it('does NOT look past a job whose location we merely failed to obtain', async () => {
    // Transparent and unknown are different: one constrains nothing, the other is a
    // constraint we could not evaluate.
    const diaryWithGap: TravelNeighbour[] = [
      known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', BRUSSELS),
      unresolved('2026-09-01T10:05:00Z', '2026-09-01T10:10:00Z'),
    ];
    expect(
      precedingNeighbour(diaryWithGap, { blockedStart: at('2026-09-01T10:15:00Z') })?.location.kind
    ).toBe('unresolved');
  });

  it('measures the drive across a locationless job, not from the end of it', async () => {
    // The owner could take that call from the van, so the window for the drive is the whole
    // span between the two physical jobs — 2.5 hours here, which clears 2 km at the floor's
    // crawl. Measured from the END of the call it would be 60 minutes, which does not.
    const neighbours = [
      known('2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z', ACROSS_TOWN),
      locationless('2026-09-01T09:30:00Z', '2026-09-01T10:30:00Z'),
    ];
    expect(
      await slotVerdict({
        candidate: candidate({ start: '2026-09-01T11:30:00Z', end: '2026-09-01T12:00:00Z' }),
        neighbours,
        minGapMin: 0,
      maxTravelMin: null,
      })
    ).toBe('clear');

    // The same pair with only the 60 minutes after the call does NOT clear — which is what
    // makes the assertion above about the window rather than about the distance.
    expect(
      await slotVerdict({
        candidate: candidate({ start: '2026-09-01T11:30:00Z', end: '2026-09-01T12:00:00Z' }),
        neighbours: [known('2026-09-01T10:00:00Z', '2026-09-01T10:30:00Z', ACROSS_TOWN)],
        minGapMin: 0,
      maxTravelMin: null,
      })
    ).toBe('undecided');
  });

  it('has NO DAY BOUNDARY: a 23:30 job and a 00:15 job are neighbours', async () => {
    const overnight = [known('2026-09-01T23:00:00Z', '2026-09-01T23:30:00Z', LIEGE)];
    const verdict = await slotVerdict({
      candidate: candidate({ start: '2026-09-02T00:15:00Z', end: '2026-09-02T01:00:00Z' }),
      neighbours: overnight,
      minGapMin: 0,
      maxTravelMin: null,
    });
    // Liège→Brussels in 45 minutes is ~87 km: possible at motorway speed, not proven at a
    // crawl. The point of the test is that the midnight boundary did not hide the neighbour.
    expect(verdict).toBe('undecided');
  });
});

describe('assessSlot — both sides at once', () => {
  it('clears a slot wedged between two next-door jobs', async () => {
    const verdict = await slotVerdict({
      candidate: candidate({ start: '2026-09-01T10:30:00Z', end: '2026-09-01T11:00:00Z', point: NEXT_DOOR }),
      neighbours: [
        known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', BRUSSELS),
        known('2026-09-01T11:30:00Z', '2026-09-01T12:00:00Z', BRUSSELS),
      ],
      minGapMin: 5,
    });
    expect(verdict).toBe('clear');
  });

  it('refuses a slot the owner could reach but could not leave', async () => {
    const verdict = await slotVerdict({
      candidate: candidate({ start: '2026-09-01T10:30:00Z', end: '2026-09-01T11:00:00Z', point: NEXT_DOOR }),
      neighbours: [
        known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', BRUSSELS),
        known('2026-09-01T11:05:00Z', '2026-09-01T12:00:00Z', LIEGE),
      ],
      minGapMin: 0,
      maxTravelMin: null,
    });
    expect(verdict).toBe('unreachable');
  });
});

describe('estimateDrive — what the owner reads before overriding', () => {
  it('gives a RANGE, because nothing has routed anything', async () => {
    const e = estimateDrive(BRUSSELS, GHENT);
    // ~47 km: about 24 minutes at the optimistic bound, about 140 at the pessimistic one.
    expect(e.km).toBeGreaterThan(45);
    expect(e.km).toBeLessThanOrEqual(50);
    expect(e.fastestMin).toBeLessThan(e.slowestMin);
    expect(e.fastestMin).toBeGreaterThan(0);
  });

  it('is zero-ish for two doors on the same street', async () => {
    const e = estimateDrive(BRUSSELS, NEXT_DOOR);
    expect(e.km).toBe(0);
    expect(e.slowestMin).toBe(0);
  });

  it('is symmetric — a drive is the same length in both directions', async () => {
    expect(estimateDrive(BRUSSELS, LIEGE)).toEqual(estimateDrive(LIEGE, BRUSSELS));
  });

  it('never claims to be a measured drive: the slow end assumes a crawl, not a road', async () => {
    // Brussels→Liège is ~87 km. The real drive is about an hour; the range must CONTAIN that
    // rather than pretend to be it, which is the whole reason it is a range.
    const e = estimateDrive(BRUSSELS, LIEGE);
    expect(e.fastestMin).toBeLessThan(60);
    expect(e.slowestMin).toBeGreaterThan(60);
  });
});

/**
 * The budget, which exists because the cache does NOT make a slot list cheap. Consecutive
 * candidates share both endpoints but differ in departure time, and the traffic-aware bucket
 * is finer than the usual slot spacing — so every slot is its own paid lookup and its own
 * round-trip a customer is waiting behind.
 */
describe('assessSlotRouted — the per-call budget', () => {
  const BAND = { lat: 50.8800, lng: 4.3517 }; // ~3 km: neither bound settles it
  const diary = (start: string, end: string) => [known(start, end, BAND)];
  const slot = (start: string, end: string) => candidate({ start, end, point: BRUSSELS });

  const counting = (minutes: number | null) => {
    const calls: RoutableLeg[] = [];
    return {
      calls,
      lookup: async (leg: RoutableLeg) => {
        calls.push(leg);
        return { minutes };
      },
    };
  };

  it('no longer stops on the count — that is now the lookup’s job, so every slot reaches it', async () => {
    // The COUNT moved to `driveMinutes` (claimed only on a real cache miss). The gate keeps just
    // the deadline, so a mocked lookup — which bypasses the count — is asked for EVERY slot, and
    // the gate never decrements `remaining`. This is the whole fix: repeated cached legs no longer
    // exhaust the budget per slot. The neighbour moves WITH each slot so every one has the same
    // 30-minute gap (a fixed neighbour would give later slots hours the floor settles for free).
    const { calls, lookup } = counting(5);
    const budget = routeBudget();
    for (let i = 0; i < 12; i += 1) {
      const hour = String(9 + i).padStart(2, '0');
      await assessSlotRouted({
        candidate: slot(`2026-09-01T${hour}:30:00Z`, `2026-09-01T${hour}:50:00Z`),
        neighbours: diary(`2026-09-01T${hour}:00:00Z`, `2026-09-01T${hour}:00:00Z`),
        minGapMin: 0,
      maxTravelMin: null,
        lookup,
        budget,
      });
    }
    expect(calls).toHaveLength(12);
    expect(budget.remaining).toBe(10);
  });

  it('degrades to a Request when the lookup reports the count is spent', async () => {
    // The real count lives in `driveMinutes`; here the lookup stands in for an exhausted count by
    // returning `budget_spent`. The gate must withhold the slot into a Request, never confirm it.
    const budget = routeBudget();
    const { verdict, fullyRouted, degradedCauses } = await assessSlotRouted({
      candidate: slot('2026-09-01T09:00:00Z', '2026-09-01T09:30:00Z'),
      neighbours: diary('2026-09-01T06:00:00Z', '2026-09-01T06:30:00Z'),
      minGapMin: 0,
      maxTravelMin: null,
      lookup: async () => ({ minutes: null, cause: 'budget_spent' as const }),
      budget,
    });
    // Withheld into a Request, never confirmed — the safe direction.
    expect(verdict).toBe('undecided');
    expect(fullyRouted).toBe(false);
    expect(degradedCauses).toContain('budget_spent');
  });

  it('stops on the deadline even with lookups left to spend, and names it route_deadline not budget_spent', async () => {
    const { calls, lookup } = counting(5);
    const budget = { remaining: 10, deadline: Date.now() - 1 };
    const { degradedCauses } = await assessSlotRouted({
      candidate: slot('2026-09-01T09:00:00Z', '2026-09-01T09:30:00Z'),
      neighbours: diary('2026-09-01T06:00:00Z', '2026-09-01T06:30:00Z'),
      minGapMin: 0,
      maxTravelMin: null,
      lookup,
      budget,
    });
    expect(calls).toHaveLength(0);
    // The LATENCY ceiling, kept distinct from the COUNT ceiling (`budget_spent`) so the monitor
    // can tell "Google/Redis is slow" from "the count is too low". See degradation-monitor.
    expect(degradedCauses).toContain('route_deadline');
    expect(degradedCauses).not.toContain('budget_spent');
  });

  it('is unbounded when no budget is given — the single-slot create path', async () => {
    const { calls, lookup } = counting(5);
    await assessSlotRouted({
      candidate: slot('2026-09-01T09:00:00Z', '2026-09-01T09:30:00Z'),
      neighbours: diary('2026-09-01T06:00:00Z', '2026-09-01T06:30:00Z'),
      minGapMin: 0,
      maxTravelMin: null,
      lookup,
    });
    expect(calls).toHaveLength(1);
  });

  it('carries WHY a leg went unanswered, which is all #68 will have to key on', async () => {
    const { verdict, degradedCauses } = await assessSlotRouted({
      candidate: slot('2026-09-01T09:00:00Z', '2026-09-01T09:30:00Z'),
      neighbours: diary('2026-09-01T06:00:00Z', '2026-09-01T06:30:00Z'),
      minGapMin: 0,
      maxTravelMin: null,
      lookup: async () => ({ minutes: null, cause: 'cap_exhausted' }),
    });
    expect(verdict).toBe('undecided');
    expect(degradedCauses).toEqual(['cap_exhausted']);
  });

  it('reports a leg the BOUNDS settled as its own cause, not as an outage', async () => {
    // Nothing was unavailable — it simply was not measured. #68 must not alert on this.
    const { fullyRouted, degradedCauses } = await assessSlotRouted({
      candidate: slot('2026-09-01T09:00:00Z', '2026-09-01T09:30:00Z'),
      neighbours: [known('2026-09-01T06:00:00Z', '2026-09-01T06:30:00Z', NEXT_DOOR)],
      minGapMin: 0,
      maxTravelMin: null,
      lookup: replayLookup({}),
    });
    expect(fullyRouted).toBe(false);
    expect(degradedCauses).toEqual(['settled_by_bounds']);
  });
});

/**
 * Which bookings may claim to have been checked at all.
 *
 * `travel_check` has a NULL that already means "the gate did not apply". A day with nothing
 * to drive between belongs there: no drive was measured, and nothing was unavailable either.
 * Stamping `ok` would claim a routing answer nobody sought; stamping `degraded` would feed a
 * permanent stream of rows into the signal #68 has to watch for outages.
 */
describe('assessSlotRouted — did anything actually constrain the verdict', () => {
  const slot = candidate({ start: '2026-09-01T10:00:00Z', end: '2026-09-01T11:00:00Z' });
  const run = (neighbours: TravelNeighbour[]) =>
    assessSlotRouted({ candidate: slot, neighbours, minGapMin: 0,
      maxTravelMin: null, lookup: replayLookup({}) });

  it('an empty day constrains nothing', async () => {
    const { verdict, hadConstrainingLeg } = await run([]);
    expect(verdict).toBe('clear');
    expect(hadConstrainingLeg).toBe(false);
  });

  it('a day of only phone jobs constrains nothing either', async () => {
    // The owner could take those from the van, so there is no drive to measure on either side.
    const { verdict, hadConstrainingLeg } = await run([
      locationless('2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z'),
      locationless('2026-09-01T12:00:00Z', '2026-09-01T13:00:00Z'),
    ]);
    expect(verdict).toBe('clear');
    expect(hadConstrainingLeg).toBe(false);
  });

  it('one real neighbour is enough to constrain it', async () => {
    const { hadConstrainingLeg } = await run([
      known('2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z', NEXT_DOOR),
    ]);
    expect(hadConstrainingLeg).toBe(true);
  });

  it('a neighbour we could not place constrains it too — that is the point of `unresolved`', async () => {
    const { verdict, hadConstrainingLeg } = await run([
      unresolved('2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z'),
    ]);
    expect(verdict).toBe('undecided');
    expect(hadConstrainingLeg).toBe(true);
  });
});

/**
 * Start from base (#76): the day's first job departs from the premises.
 *
 * The base is not a new kind of thing — it is the venue standing where a preceding job would
 * stand — so these tests are about WHEN it is inserted, which is the whole of the rule. Six
 * review rounds on the plan found defects in this mechanism and nowhere else.
 */
describe('withBaseNeighbour — when the premises count as the predecessor', () => {
  const DAY_START = at('2026-09-01T00:00:00Z');
  const OPENING = { at: at('2026-09-01T08:00:00Z'), location: { kind: 'known' as const, point: BRUSSELS } };
  const cand = candidate({ start: '2026-09-01T10:00:00Z', end: '2026-09-01T11:00:00Z' });

  it('inserts the base on an empty morning', () => {
    const out = withBaseNeighbour([], cand, OPENING, DAY_START);
    expect(out).toHaveLength(1);
    expect(out[0].blockedEnd).toEqual(OPENING.at);
  });

  it('adds nothing at all when there is no base — the off switch', () => {
    const ns = [known('2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z', GHENT)];
    expect(withBaseNeighbour(ns, cand, null, DAY_START)).toBe(ns);
  });

  it.each([
    ['a located job', known('2026-09-01T06:00:00Z', '2026-09-01T07:00:00Z', GHENT)],
    ['a town-centre job', coarse('2026-09-01T06:00:00Z', '2026-09-01T07:00:00Z', GHENT)],
    // THE ONE THAT MATTERS. An `unresolved` job is not LOCATED, so a rule written as "no
    // preceding located neighbour" would insert the base behind it, make the base the nearer
    // predecessor, and CLEAR a candidate whose real constraint we admitted we could not
    // evaluate — inverting the entire meaning of `unresolved`.
    ['a job we could not place', unresolved('2026-09-01T06:00:00Z', '2026-09-01T07:00:00Z')],
  ])('is suppressed by %s earlier the same day', (_label, neighbour) => {
    // The list comes back untouched: no base was added, and the real job stays the predecessor.
    const out = withBaseNeighbour([neighbour], cand, OPENING, DAY_START);
    expect(out).toEqual([neighbour]);
    expect(precedingNeighbour(out, cand)).toEqual(neighbour);
  });

  it('is NOT suppressed by a phone job — that constrains nothing', () => {
    const out = withBaseNeighbour([locationless('2026-09-01T06:00:00Z', '2026-09-01T07:00:00Z')], cand, OPENING, DAY_START);
    expect(out).toHaveLength(2);
  });

  it('is NOT suppressed by YESTERDAY, however late it ran', () => {
    // `precedingNeighbour` has no day boundary, so yesterday's 18:00 job is already the
    // "predecessor" of this morning. Without the day bound it would suppress the base almost
    // every day and the feature would do nothing whatsoever.
    const out = withBaseNeighbour([known('2026-08-31T17:00:00Z', '2026-08-31T18:00:00Z', GHENT)], cand, OPENING, DAY_START);
    expect(out).toHaveLength(2);
    expect(precedingNeighbour(out, cand)?.blockedEnd).toEqual(OPENING.at);
  });

  it('is NEVER the FOLLOWING neighbour — return-home is not gated', () => {
    // Appended blind, the premises also satisfy `followingNeighbour` for any candidate ending
    // before opening, and the gate would measure the drive HOME. Assumption 7 is explicit that
    // return-home is never gated: the owner's evening is not an appointment to be late for.
    const early = candidate({ start: '2026-09-01T05:00:00Z', end: '2026-09-01T06:00:00Z' });
    const out = withBaseNeighbour([], early, OPENING, DAY_START);
    expect(followingNeighbour(out, early)).toBeNull();
    expect(out).toEqual([]);
  });

  it('is not the predecessor of a job that starts BEFORE opening', () => {
    // An owner who took an 07:00 booking outside their own hours is not departing from the
    // premises at 08:00. No special case is needed: the base simply ends after the candidate
    // begins, and `precedingNeighbour` already skips those.
    const early = candidate({ start: '2026-09-01T07:00:00Z', end: '2026-09-01T08:00:00Z' });
    const out = withBaseNeighbour([], early, OPENING, DAY_START);
    expect(precedingNeighbour(out, early)).toBeNull();
  });
});

describe('selectFirstJob — what a write exposed', () => {
  const DAY_START = at('2026-09-01T00:00:00Z');
  const DAY_END = at('2026-09-02T00:00:00Z');

  it('finds nothing on an empty day', () => {
    expect(selectFirstJob([], DAY_START, DAY_END)).toEqual({ kind: 'none' });
  });

  it('picks the earliest STARTING job, not the earliest ending', () => {
    const later = known('2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z', GHENT);
    const first = known('2026-09-01T09:00:00Z', '2026-09-01T13:00:00Z', LIEGE);
    const sel = selectFirstJob([later, first], DAY_START, DAY_END);
    expect(sel.kind).toBe('assessable');
    if (sel.kind !== 'assessable') return;
    expect(sel.candidate.blockedStart).toEqual(first.blockedStart);
    // Excluded from its own neighbours, or it would measure a drive from itself to itself.
    expect(sel.others).toEqual([later]);
  });

  it('ignores a phone job — it constrains nothing and cannot be first', () => {
    const sel = selectFirstJob(
      [locationless('2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z'), known('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', GHENT)],
      DAY_START,
      DAY_END
    );
    expect(sel.kind).toBe('assessable');
    if (sel.kind !== 'assessable') return;
    expect(sel.candidate.blockedStart).toEqual(at('2026-09-01T10:00:00Z'));
  });

  it('reports a first job we could not place as unplaced, never as absent', () => {
    // Skipping it would let the day read as empty and clear a base leg nobody evaluated.
    const sel = selectFirstJob([unresolved('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z')], DAY_START, DAY_END);
    expect(sel).toEqual({ kind: 'unplaced' });
  });

  it('does not treat a job that STARTED yesterday as today’s first', () => {
    const sel = selectFirstJob([known('2026-08-31T23:00:00Z', '2026-09-01T01:00:00Z', GHENT)], DAY_START, DAY_END);
    expect(sel).toEqual({ kind: 'none' });
  });
});

describe('an estimated leg may clear a slot but may never refuse one', () => {
  /**
   * The asymmetry that makes a Google-free fallback safe.
   *
   * `haversine-lookup` produces a duration from geometry rather than roads. Measured against live
   * Google over fourteen Belgian pairs it errs LONG on nine of them, so a journey it says fits
   * almost certainly fits - but one leg came back 22% short, a 67 minute drive called 52. Refusing
   * on that turns a real customer away over arithmetic no road network was consulted for.
   *
   * Without the `estimated` flag the gate cannot tell the two apart: a duration is a duration once
   * it is a number, and line 652 would refuse on either.
   */
  // Brussels at 09:00, then a Ghent candidate at 10:00 - a 60 minute gap for a ~47 km drive.
  const gap = {
    candidate: candidate({
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T11:00:00Z',
      point: GHENT,
    }),
    neighbours: [known('2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z', BRUSSELS)],
    minGapMin: 0,
      maxTravelMin: null,
  };

  it('CLEARS on an estimate that fits', async () => {
    // Erring long is safe in this direction: if the estimate says it fits, it very likely fits.
    const { verdict } = await assessSlotRouted({
      ...gap,
      lookup: async () => ({ minutes: 20, estimated: true, cause: 'estimated' }),
    });
    expect(verdict).toBe('clear');
  });

  it('DEGRADES rather than refusing on an estimate that does not fit', async () => {
    // The load-bearing case. A measured 200 minutes would refuse; an estimated 200 must not.
    const { verdict } = await assessSlotRouted({
      ...gap,
      lookup: async () => ({ minutes: 200, estimated: true, cause: 'estimated' }),
    });
    expect(verdict).not.toBe('unreachable');
  });

  it('still REFUSES on a MEASURED duration that does not fit', async () => {
    // The control. Google saying 200 minutes is a real constraint and must still bind, or the
    // change above would have quietly disabled the whole gate.
    const { verdict } = await assessSlotRouted({
      ...gap,
      lookup: async () => ({ minutes: 200 }),
    });
    expect(verdict).toBe('unreachable');
  });

  it('never claims the slot was VERIFIED, even when the estimate cleared it', async () => {
    // `travel_check = 'ok'` means routing measured every constraining leg. A straight line did
    // not, so the stamp must not survive - CONTEXT.md defines `ok` as a claim about provenance.
    const assessment = await assessSlotRouted({
      ...gap,
      lookup: async () => ({ minutes: 20, estimated: true, cause: 'estimated' }),
    });
    expect(assessment.fullyRouted).toBe(false);
  });
});

describe('maximum travel time', () => {
  // Brussels→Ghent is ~47 km: inside the haversine band at a 45-minute cap, so the lookup
  // is what decides. Gent→Liège is already a certain-no at 45 minutes and would not test it.
  const neighbour = known('2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z', BRUSSELS);
  const cand = candidate({
    start: '2026-09-01T12:00:00Z',
    end: '2026-09-01T13:00:00Z',
    point: GHENT,
  });
  const gap180 = {
    candidate: cand,
    neighbours: [neighbour],
    minGapMin: 0,
  };

  it('refuses a 70-minute drive against a 45-minute cap', async () => {
    const { verdict } = await assessSlotRouted({
      ...gap180,
      maxTravelMin: 45,
      lookup: async () => ({ minutes: 70 }),
    });
    expect(verdict).toBe('unreachable');
  });

  it('clears a 40-minute drive against a 45-minute cap', async () => {
    const { verdict } = await assessSlotRouted({
      ...gap180,
      maxTravelMin: 45,
      lookup: async () => ({ minutes: 40 }),
    });
    expect(verdict).toBe('clear');
  });

  it('lets the gap alone decide when there is no cap', async () => {
    const { verdict } = await assessSlotRouted({
      ...gap180,
      maxTravelMin: null,
      lookup: async () => ({ minutes: 70 }),
    });
    expect(verdict).toBe('clear');
  });

  it('refuses a 300 km pair against a 30-minute cap without a lookup', async () => {
    const far: GeoPoint = { lat: 50.8503, lng: 8.7 };
    let lookedUp = 0;
    const { verdict } = await assessSlotRouted({
      candidate: candidate({
        start: '2026-09-01T14:00:00Z',
        end: '2026-09-01T15:00:00Z',
        point: far,
      }),
      neighbours: [known('2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z', BRUSSELS)],
      minGapMin: 0,
      maxTravelMin: 30,
      lookup: async () => {
        lookedUp += 1;
        return { minutes: null };
      },
    });
    expect(verdict).toBe('unreachable');
    expect(lookedUp).toBe(0);
  });

  it('keeps an estimated over-cap drive undecided', async () => {
    const { verdict } = await assessSlotRouted({
      ...gap180,
      maxTravelMin: 45,
      lookup: async () => ({ minutes: 70, estimated: true, cause: 'estimated' }),
    });
    expect(verdict).toBe('undecided');
  });
});

describe('the safety margin is the Minimum Gap', () => {
  const neighbour = known('2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z', BRUSSELS);
  const cand = candidate({
    start: '2026-09-01T10:40:00Z',
    end: '2026-09-01T11:40:00Z',
    point: GHENT,
  });

  it('refuses when drive plus Minimum Gap does not fit the free time', async () => {
    const { verdict } = await assessSlotRouted({
      candidate: cand,
      neighbours: [neighbour],
      minGapMin: 30,
      maxTravelMin: null,
      lookup: async () => ({ minutes: 75 }),
    });
    expect(verdict).toBe('unreachable');
  });

  it('clears when drive plus Minimum Gap fits', async () => {
    const { verdict } = await assessSlotRouted({
      candidate: cand,
      neighbours: [neighbour],
      minGapMin: 30,
      maxTravelMin: null,
      lookup: async () => ({ minutes: 65 }),
    });
    expect(verdict).toBe('clear');
  });
});
