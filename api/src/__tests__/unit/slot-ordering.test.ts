/**
 * #81 - the order grouping WOULD offer, and the budget that stops it starving feasibility.
 *
 * Both fail silently if they fail. A non-deterministic order makes LP4's stability gate
 * unfalsifiable rather than failed, and a scorer that eats the element cap turns confirmable
 * slots into Requests with no error anywhere - the thing ADR-0017 forbids grouping from causing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { counterfactualOrder, hasCheaperAlternative, SCORER_VERSION } from '../../booking/travel/slot-ordering';
import type { ScoredCandidate } from '../../booking/travel/insertion-scorer';

const at = (hhmm: string) => new Date(`2026-09-07T${hhmm}:00.000Z`);
const iso = (hhmm: string) => at(hhmm).toISOString();

const slot = (
  hhmm: string,
  costMinutes: number | null,
  preferred: boolean | null = costMinutes === null ? null : true
): ScoredCandidate => ({
  start: at(hhmm),
  costMinutes,
  preferred,
  neutralReason: costMinutes === null ? 'unanchored' : null,
  period: 'morning',
});

describe('the counterfactual order', () => {
  it('puts the cheapest preferred slot first - the only thing grouping actually moves', () => {
    const order = counterfactualOrder({
      scored: [slot('08:00', 40), slot('09:00', 5), slot('10:00', 20)],
      requestable: [],
    });
    expect(order).toEqual([iso('09:00'), iso('10:00'), iso('08:00')]);
  });

  it('breaks equal costs chronologically, so two runs cannot disagree', () => {
    // Without this the order inherits whatever sequence the slot generator emitted, and "stable
    // ranking" would be a property of the caller rather than of the scorer.
    const forward = counterfactualOrder({ scored: [slot('08:00', 10), slot('09:00', 10)], requestable: [] });
    const reversed = counterfactualOrder({ scored: [slot('09:00', 10), slot('08:00', 10)], requestable: [] });
    expect(forward).toEqual(reversed);
    expect(forward).toEqual([iso('08:00'), iso('09:00')]);
  });

  it('keeps unpreferred and neutral slots chronological, below the preferred ones', () => {
    // Over the threshold and unscored are both "no opinion", and neither is a reason to bury a
    // time the customer can actually have.
    const order = counterfactualOrder({
      scored: [slot('11:00', 90, false), slot('08:00', null), slot('09:00', 5)],
      requestable: [],
    });
    expect(order).toEqual([iso('09:00'), iso('08:00'), iso('11:00')]);
  });

  it('never promotes a requestable slot above a confirmable one', () => {
    // A slot travel could not clear is not a slot to steer anyone toward: promoting it offers a
    // customer a time the owner may still refuse.
    const order = counterfactualOrder({
      scored: [slot('14:00', 30)],
      requestable: [at('08:00'), at('09:00')],
    });
    expect(order).toEqual([iso('14:00'), iso('08:00'), iso('09:00')]);
  });

  it('orders nothing when nothing was scored', () => {
    expect(counterfactualOrder({ scored: [], requestable: [] })).toEqual([]);
  });

  it('has a version, so a changed order can be told from an unstable one', () => {
    expect(SCORER_VERSION).toMatch(/^lp4-/);
  });
});

describe('whether steering had anywhere better to point', () => {
  it('sees a saving worth the nudge', () => {
    const scored = [slot('08:00', 40), slot('09:00', 5)];
    expect(hasCheaperAlternative(scored, at('08:00'), 10)).toBe(true);
  });

  it('ignores a saving below the floor', () => {
    // A two-minute improvement is not worth telling a customer their preferred time is worse.
    const scored = [slot('08:00', 12), slot('09:00', 10)];
    expect(hasCheaperAlternative(scored, at('08:00'), 10)).toBe(false);
  });

  it('answers false when the offered slot itself was never scored', () => {
    // No comparison is possible, which is NOT the same as no alternative - counting it as one
    // would inflate the very number that decides whether the pilot is worth running.
    const scored = [slot('08:00', null), slot('09:00', 5)];
    expect(hasCheaperAlternative(scored, at('08:00'), 10)).toBe(false);
  });
});

describe('grouping cannot starve feasibility', () => {
  const reserve = vi.fn();
  beforeEach(() => vi.resetModules());

  it('reserves against a FRACTION of the cap, so the optional caller stops first', async () => {
    vi.doMock('../../booking/travel/travel-usage.service', () => ({ reserveTravelElements: reserve }));
    reserve.mockResolvedValue(true);
    const { reserveGroupingElements, GROUPING_CAP_SHARE } = await import('../../booking/travel/grouping-budget');

    await reserveGroupingElements('tenant-1', 3);

    // The third argument is the whole guarantee: feasibility passes 1 and is unaffected, while
    // grouping is refused once total spend passes its share - whoever spent it.
    expect(reserve).toHaveBeenCalledWith('tenant-1', 3, GROUPING_CAP_SHARE);
    expect(GROUPING_CAP_SHARE).toBeLessThan(1);
  });

  it('says no rather than throwing when the ledger itself fails', async () => {
    // Failing closed is right here and is the opposite of the feasibility path's instinct.
    // Feasibility that cannot check must decide something about a customer; grouping that cannot
    // check simply has no opinion, and silence costs nothing.
    vi.doMock('../../booking/travel/travel-usage.service', () => ({
      reserveTravelElements: vi.fn().mockRejectedValue(new Error('ledger down')),
    }));
    const { reserveGroupingElements } = await import('../../booking/travel/grouping-budget');
    await expect(reserveGroupingElements('tenant-1', 3)).resolves.toBe(false);
  });
});
