import { describe, it, expect } from 'vitest';
import {
  assessTravel,
  assessSlot,
  estimateDrive,
  precedingNeighbour,
  followingNeighbour,
  type TravelNeighbour,
  type TravelCandidate,
} from '../../booking/travel/travel-gate';
import type { GeoPoint } from '../../contracts/travel';

/** Real Belgian coordinates, so every distance below is checkable against a map. */
const BRUSSELS: GeoPoint = { lat: 50.8503, lng: 4.3517 };
const GHENT: GeoPoint = { lat: 51.0543, lng: 3.7174 }; // ~47 km from Brussels
const LIEGE: GeoPoint = { lat: 50.6326, lng: 5.5797 }; // ~87 km from Brussels
const NEXT_DOOR: GeoPoint = { lat: 50.8504, lng: 4.3518 }; // metres from Brussels

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

describe('assessTravel — the certain no', () => {
  it('refuses a slot whose preceding job cannot possibly be left in time', () => {
    // Liège→Brussels is ~87 km straight line. A 10-minute gap covers 20 km at motorway
    // speed. Not even a helicopter fits.
    const verdict = assessTravel({
      candidate: candidate({ start: '2026-09-01T10:10:00Z', end: '2026-09-01T11:00:00Z' }),
      before: known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', LIEGE),
      after: null,
      slackMin: 0,
    });
    expect(verdict).toBe('unreachable');
  });

  it('refuses on the FOLLOWING side too — the drive out is as real as the drive in', () => {
    const verdict = assessTravel({
      candidate: candidate({ start: '2026-09-01T09:00:00Z', end: '2026-09-01T10:00:00Z' }),
      before: null,
      after: known('2026-09-01T10:10:00Z', '2026-09-01T11:00:00Z', LIEGE),
      slackMin: 0,
    });
    expect(verdict).toBe('unreachable');
  });

  it('spends the slack before the drive, so a big margin can make a short hop impossible', () => {
    // 60 minutes of gap, but 58 of them are the owner's own margin: 2 minutes left, and
    // 47 km does not fit in 2 minutes.
    const verdict = assessTravel({
      candidate: candidate({ start: '2026-09-01T11:00:00Z', end: '2026-09-01T12:00:00Z' }),
      before: known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', GHENT),
      after: null,
      slackMin: 58,
    });
    expect(verdict).toBe('unreachable');
  });
});

describe('assessTravel — the certain yes', () => {
  it('clears two jobs a few doors apart', () => {
    const verdict = assessTravel({
      candidate: candidate({ start: '2026-09-01T10:30:00Z', end: '2026-09-01T11:00:00Z', point: NEXT_DOOR }),
      before: known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', BRUSSELS),
      after: null,
      slackMin: 5,
    });
    expect(verdict).toBe('clear');
  });

  it('clears an empty day', () => {
    expect(
      assessTravel({
        candidate: candidate({ start: '2026-09-01T10:00:00Z', end: '2026-09-01T11:00:00Z' }),
        before: null,
        after: null,
        slackMin: 15,
      })
    ).toBe('clear');
  });
});

describe('assessTravel — the undecided middle', () => {
  it('cannot settle a pair between the two bounds', () => {
    // Ghent→Brussels is ~47 km. A 60-minute gap covers 120 km at motorway speed (so it
    // could fit) but only 20 km at the pessimistic crawl (so it is not proven to fit).
    const verdict = assessTravel({
      candidate: candidate({ start: '2026-09-01T11:00:00Z', end: '2026-09-01T12:00:00Z' }),
      before: known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', GHENT),
      after: null,
      slackMin: 0,
    });
    expect(verdict).toBe('undecided');
  });

  it('lets an impossible side override an undecided one', () => {
    const verdict = assessTravel({
      candidate: candidate({ start: '2026-09-01T11:00:00Z', end: '2026-09-01T12:00:00Z' }),
      before: known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', GHENT), // undecided
      after: known('2026-09-01T12:05:00Z', '2026-09-01T13:00:00Z', LIEGE), // impossible
      slackMin: 0,
    });
    expect(verdict).toBe('unreachable');
  });
});

describe('assessTravel — what a neighbour without coordinates means', () => {
  it('treats a locationless neighbour as no constraint at all', () => {
    // A phone consultation. The owner could take it from the van, so the flat gap — which
    // was already applied before this function ran — is the whole rule.
    expect(
      assessTravel({
        candidate: candidate({ start: '2026-09-01T10:05:00Z', end: '2026-09-01T11:00:00Z' }),
        before: locationless('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
        after: null,
        slackMin: 0,
      })
    ).toBe('clear');
  });

  it('never clears past a neighbour whose location we merely FAILED to obtain', () => {
    // The distinction that stops this feature silently confirming a drive nobody checked:
    // "has no location" and "we could not get its location" are opposite claims.
    expect(
      assessTravel({
        candidate: candidate({ start: '2026-09-01T10:05:00Z', end: '2026-09-01T11:00:00Z' }),
        before: unresolved('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
        after: null,
        slackMin: 0,
      })
    ).toBe('undecided');
  });
});

describe('assessTravel — coarse points may refuse, never clear', () => {
  it('lets a town-centre neighbour prove a drive impossible', () => {
    expect(
      assessTravel({
        candidate: candidate({ start: '2026-09-01T10:10:00Z', end: '2026-09-01T11:00:00Z' }),
        before: coarse('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', LIEGE),
        after: null,
        slackMin: 0,
      })
    ).toBe('unreachable');
  });

  it('refuses to let a town-centre neighbour clear one, however close the dot looks', () => {
    expect(
      assessTravel({
        candidate: candidate({ start: '2026-09-01T10:30:00Z', end: '2026-09-01T11:00:00Z', point: NEXT_DOOR }),
        before: coarse('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', BRUSSELS),
        after: null,
        slackMin: 0,
      })
    ).toBe('undecided');
  });

  it('refuses to clear a COARSE CANDIDATE even with no neighbours anywhere', () => {
    // The rule the per-side logic cannot express on its own. An empty day would otherwise
    // auto-confirm a job at an address located only to a municipality, and stamp it checked.
    expect(
      assessTravel({
        candidate: candidate({ start: '2026-09-01T10:00:00Z', end: '2026-09-01T11:00:00Z', coarse: true }),
        before: null,
        after: null,
        slackMin: 0,
      })
    ).toBe('undecided');
  });

  it('refuses to clear a coarse candidate past locationless neighbours either', () => {
    expect(
      assessTravel({
        candidate: candidate({ start: '2026-09-01T10:05:00Z', end: '2026-09-01T11:00:00Z', coarse: true }),
        before: locationless('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
        after: locationless('2026-09-01T11:05:00Z', '2026-09-01T12:00:00Z'),
        slackMin: 0,
      })
    ).toBe('undecided');
  });

  it('still refuses a coarse candidate that is provably too far', () => {
    expect(
      assessTravel({
        candidate: candidate({
          start: '2026-09-01T10:10:00Z',
          end: '2026-09-01T11:00:00Z',
          point: LIEGE,
          coarse: true,
        }),
        before: known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', BRUSSELS),
        after: null,
        slackMin: 0,
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

  it('picks the LATEST job that finishes before the slot, not merely one of them', () => {
    const before = precedingNeighbour(diary, { blockedStart: at('2026-09-01T11:00:00Z') });
    expect(before?.blockedEnd.toISOString()).toBe('2026-09-01T10:00:00.000Z');
  });

  it('picks the EARLIEST job that starts after the slot', () => {
    const after = followingNeighbour(diary, { blockedEnd: at('2026-09-01T11:00:00Z') });
    expect(after?.blockedStart.toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });

  it('returns null on the empty sides of a diary', () => {
    expect(precedingNeighbour(diary, { blockedStart: at('2026-09-01T07:00:00Z') })).toBeNull();
    expect(followingNeighbour(diary, { blockedEnd: at('2026-09-01T16:00:00Z') })).toBeNull();
  });

  it('ignores a job that overlaps the candidate — overlap is not travel s business', () => {
    // 11:30 sits inside the 12:00-13:00 job's blocked range on neither side; the exclusion
    // constraint is what refuses a real overlap, and it did so before this ran.
    const overlapping = [known('2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z', LIEGE)];
    expect(precedingNeighbour(overlapping, { blockedStart: at('2026-09-01T11:30:00Z') })).toBeNull();
    expect(followingNeighbour(overlapping, { blockedEnd: at('2026-09-01T11:30:00Z') })).toBeNull();
  });

  it('LOOKS PAST a locationless job to the last place the owner had to be', () => {
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
      assessSlot({
        candidate: candidate({ start: '2026-09-01T10:15:00Z', end: '2026-09-01T11:00:00Z', point: LIEGE }),
        neighbours: diaryWithCall,
        slackMin: 0,
      })
    ).toBe('unreachable');
  });

  it('does NOT look past a job whose location we merely failed to obtain', () => {
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

  it('measures the drive across a locationless job, not from the end of it', () => {
    // The owner could take that call from the van, so the window for the drive is the whole
    // span between the two physical jobs — 2.5 hours here, which clears 47 km even at a crawl.
    // Measured from the END of the call it would be 60 minutes, which proves nothing.
    expect(
      assessSlot({
        candidate: candidate({ start: '2026-09-01T11:30:00Z', end: '2026-09-01T12:00:00Z' }),
        neighbours: [
          known('2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z', GHENT),
          locationless('2026-09-01T09:30:00Z', '2026-09-01T10:30:00Z'),
        ],
        slackMin: 0,
      })
    ).toBe('clear');
  });

  it('has NO DAY BOUNDARY: a 23:30 job and a 00:15 job are neighbours', () => {
    const overnight = [known('2026-09-01T23:00:00Z', '2026-09-01T23:30:00Z', LIEGE)];
    const verdict = assessSlot({
      candidate: candidate({ start: '2026-09-02T00:15:00Z', end: '2026-09-02T01:00:00Z' }),
      neighbours: overnight,
      slackMin: 0,
    });
    // Liège→Brussels in 45 minutes is ~87 km: possible at motorway speed, not proven at a
    // crawl. The point of the test is that the midnight boundary did not hide the neighbour.
    expect(verdict).toBe('undecided');
  });
});

describe('assessSlot — both sides at once', () => {
  it('clears a slot wedged between two next-door jobs', () => {
    const verdict = assessSlot({
      candidate: candidate({ start: '2026-09-01T10:30:00Z', end: '2026-09-01T11:00:00Z', point: NEXT_DOOR }),
      neighbours: [
        known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', BRUSSELS),
        known('2026-09-01T11:30:00Z', '2026-09-01T12:00:00Z', BRUSSELS),
      ],
      slackMin: 5,
    });
    expect(verdict).toBe('clear');
  });

  it('refuses a slot the owner could reach but could not leave', () => {
    const verdict = assessSlot({
      candidate: candidate({ start: '2026-09-01T10:30:00Z', end: '2026-09-01T11:00:00Z', point: NEXT_DOOR }),
      neighbours: [
        known('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', BRUSSELS),
        known('2026-09-01T11:05:00Z', '2026-09-01T12:00:00Z', LIEGE),
      ],
      slackMin: 0,
    });
    expect(verdict).toBe('unreachable');
  });
});

describe('estimateDrive — what the owner reads before overriding', () => {
  it('gives a RANGE, because nothing has routed anything', () => {
    const e = estimateDrive(BRUSSELS, GHENT);
    // ~47 km: about 24 minutes at the optimistic bound, about 140 at the pessimistic one.
    expect(e.km).toBeGreaterThan(45);
    expect(e.km).toBeLessThanOrEqual(50);
    expect(e.fastestMin).toBeLessThan(e.slowestMin);
    expect(e.fastestMin).toBeGreaterThan(0);
  });

  it('is zero-ish for two doors on the same street', () => {
    const e = estimateDrive(BRUSSELS, NEXT_DOOR);
    expect(e.km).toBe(0);
    expect(e.slowestMin).toBe(0);
  });

  it('is symmetric — a drive is the same length in both directions', () => {
    expect(estimateDrive(BRUSSELS, LIEGE)).toEqual(estimateDrive(LIEGE, BRUSSELS));
  });

  it('never claims to be a measured drive: the slow end assumes a crawl, not a road', () => {
    // Brussels→Liège is ~87 km. The real drive is about an hour; the range must CONTAIN that
    // rather than pretend to be it, which is the whole reason it is a range.
    const e = estimateDrive(BRUSSELS, LIEGE);
    expect(e.fastestMin).toBeLessThan(60);
    expect(e.slowestMin).toBeGreaterThan(60);
  });
});
