/**
 * An estimate may clear a slot. It may never refuse one.
 *
 * That asymmetry is the entire contract of the fallback, and it is not a preference - it comes
 * from measuring the estimator against live Google over fourteen Belgian pairs
 * (`scripts/compare-drive-estimates.ts`). It errs LONG on nine of them, so a journey it says fits
 * almost certainly fits. But one leg came back 22% short - a 67 minute drive called 52 - and a
 * refusal there turns a real customer away over arithmetic no road network was consulted for.
 *
 * Without these tests the asymmetry is a comment, and `travel-gate.ts` would happily refuse on an
 * estimate because a duration is a duration once it is a number.
 */
import { describe, it, expect } from 'vitest';
import { estimateDriveMinutes, haversineDriveLookup } from '../../booking/travel/haversine-lookup';

const antwerp = { lat: 51.2213, lng: 4.3997 };
const ghent = { lat: 51.0543, lng: 3.7226 };
const meir = { lat: 51.2177, lng: 4.4127 };

describe('estimateDriveMinutes', () => {
  it('lands within a quarter of what Google says for an intercity drive', () => {
    // Google: 56 minutes for Antwerp -> Ghent, measured 2026-08-12. The fitted model gives 59.
    const est = estimateDriveMinutes(antwerp, ghent);
    expect(est).toBeGreaterThan(56 * 0.75);
    expect(est).toBeLessThan(56 * 1.25);
  });

  it('does NOT collapse a short hop to nothing, which the naive model did', () => {
    // Two kilometres across Antwerp. A cruising-speed model said 3 minutes; the real drive is
    // about 5, and 550 metres under the Scheldt is 16.7. The intercept is what makes short
    // journeys behave, and dropping it is the mistake this pins.
    expect(estimateDriveMinutes(antwerp, meir)).toBeGreaterThanOrEqual(15);
  });

  it('rounds UP, because rounding a drive down authorises a booking nobody can make', () => {
    expect(Number.isInteger(estimateDriveMinutes(antwerp, ghent))).toBe(true);
  });

  it('is symmetric and deterministic — the same pair always gives the same answer', () => {
    // The property an LLM could not offer: ask twice, get the same number.
    expect(estimateDriveMinutes(antwerp, ghent)).toBe(estimateDriveMinutes(ghent, antwerp));
    expect(estimateDriveMinutes(antwerp, ghent)).toBe(estimateDriveMinutes(antwerp, ghent));
  });
});

describe('haversineDriveLookup', () => {
  it('MARKS every answer as estimated, which is what stops it refusing', () => {
    // The one field the gate branches on. Without it an estimate is indistinguishable from a
    // measured drive, and `travel-gate.ts` would let a straight line turn a customer away.
    return haversineDriveLookup()({
      from: antwerp,
      to: ghent,
      departAt: new Date(),
      budgetMin: 10,
    } as never).then((leg) => {
      expect(leg.estimated).toBe(true);
      expect(leg.minutes).toBeGreaterThan(0);
    });
  });

  it('carries a cause distinct from a failure, so monitoring can tell them apart', () => {
    // "We chose not to ask" is not "we asked and could not get an answer". #68 keys on this.
    return haversineDriveLookup()({
      from: antwerp,
      to: meir,
      departAt: new Date(),
      budgetMin: 10,
    } as never).then((leg) => expect(leg.cause).toBe('estimated'));
  });

  it('never calls anything — it resolves with no key, no network and no tenant', async () => {
    // The whole point of the fallback: it works when Google does not.
    const leg = await haversineDriveLookup()({
      from: antwerp,
      to: ghent,
      departAt: new Date(),
      budgetMin: 5,
    } as never);
    expect(leg.minutes).not.toBeNull();
  });
});

describe('padding, and why the fallback is deliberately pessimistic', () => {
  it('inflates by default, because a fallback answer is the least-checked answer', async () => {
    const raw = estimateDriveMinutes(antwerp, ghent);
    const padded = await haversineDriveLookup()({
      from: antwerp,
      to: ghent,
      departAt: new Date(),
      budgetMin: 999,
    } as never);
    expect(padded.minutes!).toBeGreaterThan(raw);
  });

  it('covers the worst under-estimate the measurement actually found', async () => {
    // Antwerp -> Brussels: Google says 67, the raw model says 52, which is 22% short. Padding has
    // to close that gap or the fallback would clear a journey the owner cannot make.
    const brussels = { lat: 50.8467, lng: 4.3525 };
    const padded = await haversineDriveLookup()({
      from: antwerp,
      to: brussels,
      departAt: new Date(),
      budgetMin: 999,
    } as never);
    expect(padded.minutes!).toBeGreaterThanOrEqual(67);
  });

  it('can be asked NOT to pad, for ranking where both sides inflate equally', async () => {
    // Grouping compares two candidates. Inflating both changes nothing about which is nearer, and
    // padding there would only make the numbers less like the drives they describe.
    const raw = estimateDriveMinutes(antwerp, ghent);
    const unpadded = await haversineDriveLookup({ padded: false })({
      from: antwerp,
      to: ghent,
      departAt: new Date(),
      budgetMin: 999,
    } as never);
    expect(unpadded.minutes).toBe(raw);
  });
});
