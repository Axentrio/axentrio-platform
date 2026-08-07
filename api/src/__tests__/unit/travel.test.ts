import { describe, it, expect } from 'vitest';
import {
  haversineKm,
  couldReachWithin,
  certainlyReachableWithin,
  travelGapMinutes,
  travelCacheKey,
  isTrustedForTravel,
  PREFILTER_MAX_KMH,
  PREFILTER_MIN_KMH,
  type GeoPoint,
} from '../../contracts/travel';

/** Real Belgian coordinates, so the distances below are checkable against a map. */
const BRUSSELS: GeoPoint = { lat: 50.8503, lng: 4.3517 };
const GHENT: GeoPoint = { lat: 51.0543, lng: 3.7174 };
const ANTWERP: GeoPoint = { lat: 51.2194, lng: 4.4025 };
/** Two doors on the same street — the case that must not cost an API element. */
const NEXT_DOOR: GeoPoint = { lat: 50.8504, lng: 4.3518 };

/**
 * THE PAIR THAT FALSIFIED THE OLD FLOOR, with real coordinates and a real measured drive.
 *
 * Sint-Jansvliet and Frederik van Eedenplein sit on opposite banks of the Scheldt in
 * Antwerp: 550 m apart, 16.7 minutes by road (live Routes, 2026-08-07), because the route
 * goes under the river. 2.0 km/h effective.
 *
 * These are held-out numbers, not the samples the constant was fitted to. Asserting against
 * `PREFILTER_MIN_KMH` would be circular — it would pass at any value — so the assertions
 * below use the measured 16.7 directly. If someone raises the constant back toward 20, this
 * is the test that fails.
 */
const SCHELDT_WEST: GeoPoint = { lat: 51.2196, lng: 4.3958 };
const SCHELDT_EAST: GeoPoint = { lat: 51.2185, lng: 4.3891 };
const SCHELDT_REAL_DRIVE_MIN = 16.7;

describe('haversineKm', () => {
  it('measures a known intercity distance', () => {
    // Brussels→Ghent is ~47 km as the crow flies (~56 km by road).
    expect(haversineKm(BRUSSELS, GHENT)).toBeGreaterThan(45);
    expect(haversineKm(BRUSSELS, GHENT)).toBeLessThan(50);
  });

  it('is zero for a point against itself, and symmetric', () => {
    expect(haversineKm(BRUSSELS, BRUSSELS)).toBe(0);
    expect(haversineKm(BRUSSELS, ANTWERP)).toBeCloseTo(haversineKm(ANTWERP, BRUSSELS), 9);
  });

  it('does not NaN on antipodal points (the sqrt domain guard)', () => {
    expect(Number.isFinite(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 }))).toBe(true);
  });
});

describe('couldReachWithin — the certain-no pre-filter', () => {
  it('rejects a drive that not even a straight line at motorway speed fits', () => {
    // ~47 km straight line; 10 minutes at 120 km/h covers 20 km. Impossible.
    expect(couldReachWithin(BRUSSELS, GHENT, 10)).toBe(false);
  });

  it('allows the same pair when the gap is genuinely large', () => {
    expect(couldReachWithin(BRUSSELS, GHENT, 60)).toBe(true);
  });

  it('is exactly the physics bound at the boundary', () => {
    const km = haversineKm(BRUSSELS, GHENT);
    const exactMinutes = (km / PREFILTER_MAX_KMH) * 60;
    expect(couldReachWithin(BRUSSELS, GHENT, exactMinutes)).toBe(true);
    expect(couldReachWithin(BRUSSELS, GHENT, exactMinutes - 0.001)).toBe(false);
  });

  it('treats a zero gap as reachable only when the points coincide', () => {
    expect(couldReachWithin(BRUSSELS, BRUSSELS, 0)).toBe(true);
    expect(couldReachWithin(BRUSSELS, NEXT_DOOR, 0)).toBe(false);
    expect(couldReachWithin(BRUSSELS, GHENT, -5)).toBe(false);
  });
});

describe('certainlyReachableWithin — the certain-yes pre-filter', () => {
  it('skips the lookup for two doors on the same street', () => {
    expect(certainlyReachableWithin(NEXT_DOOR, BRUSSELS, 30)).toBe(true);
  });

  it('still asks for an intercity pair, even with a generous gap', () => {
    // The regression that motivated the second constant: 47 km DOES fit 60 min at the
    // optimistic 120 km/h, so a single shared bound waved this through — while the real
    // Brussels→Ghent drive is ~50 min plus parking, i.e. it does not fit at all.
    expect(certainlyReachableWithin(BRUSSELS, GHENT, 60)).toBe(false);
    // …and the optimistic bound would indeed have said yes. This is the asymmetry.
    expect(couldReachWithin(BRUSSELS, GHENT, 60)).toBe(true);
  });

  it('is exactly the pessimistic bound at the boundary', () => {
    const km = haversineKm(BRUSSELS, NEXT_DOOR);
    const exactMinutes = (km / PREFILTER_MIN_KMH) * 60;
    expect(certainlyReachableWithin(BRUSSELS, NEXT_DOOR, exactMinutes)).toBe(true);
    expect(certainlyReachableWithin(BRUSSELS, NEXT_DOOR, exactMinutes * 0.999)).toBe(false);
  });

  it('never waves through a zero or negative gap', () => {
    expect(certainlyReachableWithin(NEXT_DOOR, BRUSSELS, 0)).toBe(false);
    expect(certainlyReachableWithin(NEXT_DOOR, BRUSSELS, -10)).toBe(false);
  });

  it('leaves a band between the two bounds where Google must be asked', () => {
    // Neither filter is conclusive here, which is the whole point of having both.
    const gap = 40;
    expect(couldReachWithin(BRUSSELS, GHENT, gap)).toBe(true);
    expect(certainlyReachableWithin(BRUSSELS, GHENT, gap)).toBe(false);
  });

  it('does not clear the Scheldt crossing inside its real drive time', () => {
    // The regression this constant exists to prevent. 550 m apart and a 16.7 minute drive,
    // so any gap shorter than that must NOT be cleared — at the old 20 km/h every gap from
    // ~1.7 minutes up was, and ordinary business minimum gaps are 5 to 15.
    for (const gap of [2, 5, 10, 15]) {
      expect(
        certainlyReachableWithin(SCHELDT_WEST, SCHELDT_EAST, gap),
        `a ${gap}-minute gap must not clear a ${SCHELDT_REAL_DRIVE_MIN}-minute drive`
      ).toBe(false);
    }
  });

  it('still clears the Scheldt crossing once the gap genuinely covers the drive', () => {
    // The floor must not be so low that it refuses to clear anything — that would make the
    // branch dead code and leave degraded mode with nothing it can confirm.
    expect(certainlyReachableWithin(SCHELDT_WEST, SCHELDT_EAST, 45)).toBe(true);
  });

  it('still skips the lookup for the case the branch exists for', () => {
    // A next-door job at an ordinary gap. If this ever goes false the floor has been lowered
    // past usefulness and every travel booking starts costing an element.
    expect(certainlyReachableWithin(BRUSSELS, NEXT_DOOR, 30)).toBe(true);
  });
});

describe('travelGapMinutes', () => {
  it('degrades to exactly the flat gap when there is no routing answer', () => {
    expect(travelGapMinutes({ driveMin: null, slackMin: 10, minGapMin: 15 })).toBe(15);
  });

  it('does not add slack to the unknown case', () => {
    // The regression that would quietly tighten every business not using this feature.
    expect(travelGapMinutes({ driveMin: null, slackMin: 45, minGapMin: 5 })).toBe(5);
  });

  it('keeps the flat gap as a floor when the drive is short', () => {
    expect(travelGapMinutes({ driveMin: 2, slackMin: 3, minGapMin: 20 })).toBe(20);
  });

  it('raises the gap to drive + slack when the drive dominates', () => {
    // Achraf's case: 30-minute drive, 10 minutes of slack, a 5-minute flat gap.
    expect(travelGapMinutes({ driveMin: 30, slackMin: 10, minGapMin: 5 })).toBe(40);
  });

  it('treats a malformed drive time as unknown rather than as zero', () => {
    expect(travelGapMinutes({ driveMin: NaN, slackMin: 10, minGapMin: 15 })).toBe(15);
    expect(travelGapMinutes({ driveMin: -1, slackMin: 10, minGapMin: 15 })).toBe(15);
    expect(travelGapMinutes({ driveMin: Infinity, slackMin: 10, minGapMin: 15 })).toBe(15);
  });

  it('normalises negative configuration to zero instead of subtracting', () => {
    expect(travelGapMinutes({ driveMin: 30, slackMin: -10, minGapMin: -5 })).toBe(30);
  });

  it('is zero only when nothing is configured and nothing is known', () => {
    expect(travelGapMinutes({ driveMin: null, slackMin: 0, minGapMin: 0 })).toBe(0);
  });
});

describe('isTrustedForTravel', () => {
  it('accepts the three precise placements', () => {
    expect(isTrustedForTravel('rooftop')).toBe(true);
    expect(isTrustedForTravel('range_interpolated')).toBe(true);
    expect(isTrustedForTravel('geometric_center')).toBe(true);
  });

  it('refuses a city centroid, so a vague address never gates a booking', () => {
    expect(isTrustedForTravel('approximate')).toBe(false);
    expect(isTrustedForTravel(null)).toBe(false);
    expect(isTrustedForTravel(undefined)).toBe(false);
  });
});

describe('travelCacheKey', () => {
  it('collapses two doors in the same building onto one key', () => {
    const a = travelCacheKey({ lat: 50.85031, lng: 4.35172 }, GHENT, 'driving');
    const b = travelCacheKey({ lat: 50.850314, lng: 4.351719 }, GHENT, 'driving');
    expect(a).toBe(b);
  });

  it('keeps distinct addresses, directions and modes apart', () => {
    expect(travelCacheKey(BRUSSELS, GHENT, 'driving')).not.toBe(travelCacheKey(BRUSSELS, ANTWERP, 'driving'));
    // Direction matters: one-way systems make A→B and B→A genuinely different drives.
    expect(travelCacheKey(BRUSSELS, GHENT, 'driving')).not.toBe(travelCacheKey(GHENT, BRUSSELS, 'driving'));
    expect(travelCacheKey(BRUSSELS, GHENT, 'driving')).not.toBe(travelCacheKey(BRUSSELS, GHENT, 'bicycle'));
  });
});
