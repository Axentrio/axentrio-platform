/**
 * #81 - the order grouping WOULD offer, and the budget that stops it starving feasibility.
 *
 * Both fail silently if they fail. A non-deterministic order makes LP4's stability gate
 * unfalsifiable rather than failed, and a scorer that eats the element cap turns confirmable
 * slots into Requests with no error anywhere - the thing ADR-0017 forbids grouping from causing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  counterfactualOrder,
  hasCheaperAlternative,
  orderSlotsByRoutePriority,
  SCORER_VERSION,
} from '../../booking/travel/slot-ordering';
import type { ScoredCandidate } from '../../booking/travel/insertion-scorer';
import type { RoutePriority } from '../../contracts/travel';

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

describe('Route Priority is a sort, and nothing else', () => {
  // Mixed list: two scored Slots, one unpreferred-but-scored, one true neutral. Chronological
  // input is 08 / 09 / 10 / 11. Unpreferred ARE scored and participate; only a missing cost is
  // a true neutral and must keep its chronological place.
  const mixed = [
    slot('08:00', 40),
    slot('09:00', null),
    slot('10:00', 5),
    slot('11:00', 90, false),
  ];
  const requestable = [at('14:00')];

  it('leaves auto identical to the existing counterfactual order', () => {
    const auto = orderSlotsByRoutePriority({
      scored: mixed,
      requestable,
      mode: 'auto',
    });
    expect(auto).toEqual(counterfactualOrder({ scored: mixed, requestable }));
  });

  it('orders nearest by already-computed cost among scored Slots only', () => {
    // Scored subsequence 08 / 10 / 11 becomes 10 (5), 08 (40), 11 (90). The 09:00
    // neutral keeps the chronological index it already had.
    expect(
      orderSlotsByRoutePriority({ scored: mixed, requestable: [], mode: 'nearest' })
    ).toEqual([iso('10:00'), iso('09:00'), iso('08:00'), iso('11:00')]);
  });

  it('inverts that scored-only order for farthest', () => {
    expect(
      orderSlotsByRoutePriority({ scored: mixed, requestable: [], mode: 'farthest' })
    ).toEqual([iso('11:00'), iso('09:00'), iso('08:00'), iso('10:00')]);
  });

  it('keeps a true neutral in its chronological place for nearest and farthest', () => {
    // applyGrouping's ?? Infinity would push a missing key to the back. That is illegal here:
    // a Slot the scorer never measured must not be buried by a sort that never looked at it.
    // Auto's own neutral placement is left alone — preferred Slots still rise above it.
    expect(orderSlotsByRoutePriority({ scored: mixed, requestable: [], mode: 'auto' }).indexOf(iso('09:00'))).toBe(2);
    expect(orderSlotsByRoutePriority({ scored: mixed, requestable: [], mode: 'nearest' }).indexOf(iso('09:00'))).toBe(1);
    expect(orderSlotsByRoutePriority({ scored: mixed, requestable: [], mode: 'farthest' }).indexOf(iso('09:00'))).toBe(1);
  });

  it('offers the same Slots in every mode — membership never changes', () => {
    const members = (mode: RoutePriority) =>
      [...orderSlotsByRoutePriority({ scored: mixed, requestable, mode })].sort();
    expect(members('nearest')).toEqual(members('auto'));
    expect(members('farthest')).toEqual(members('auto'));
  });
});

describe('grouping cannot starve feasibility', () => {
  // The guarantee is STRUCTURAL, not a ceiling, and the difference decides whether it holds.
  // Grouping and the feasibility gate share one monthly element counter, so a scorer capped to
  // some fraction of it still brings a tenant closer to exhaustion - and a tenant who would have
  // finished the month inside the cap can be pushed past it purely because scoring ran. An
  // exhausted gate turns confirmable slots into Requests, which ADR-0017 forbids grouping from
  // causing. So grouping buys nothing at all: it reads the conversation's cache or goes neutral.
  const reserveTravelElements = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    reserveTravelElements.mockReset().mockResolvedValue(true);
    vi.doMock('../../booking/travel/travel-usage.service', () => ({ reserveTravelElements }));
    vi.doMock('../../config/environment', async () => {
      const actual = await vi.importActual<typeof import('../../config/environment')>('../../config/environment');
      // A key must be present or `driveMinutes` returns before it ever reaches the cache or the
      // reservation, and every one of these would pass without testing anything.
      return { ...actual, config: { ...actual.config, travel: { ...actual.config.travel, googleMapsApiKey: 'k' } } };
    });
  });

  const eligibility = {
    active: true as const,
    tenantId: 'tenant-1',
    itineraryKey: 'bot:1',
    slackMin: 0,
    startFromBase: false,
    maxDetourMin: null, baseDepartOffsetMin: 0, groupingPeriod: 'none' as const, routePriority: 'auto' as const,
  };
  const leg = {
    from: { lat: 1, lng: 1 },
    to: { lat: 2, lng: 2 },
    budgetMin: 60,
    departAt: new Date(Date.now() + 3_600_000),
  };

  it('never reserves an element, so it cannot move anyone closer to their cap', async () => {
    const { driveLookupFor } = await import('../../booking/travel/routes.service');

    const answer = await driveLookupFor(eligibility, 'sess-1', { cacheOnly: true })(leg);

    expect(reserveTravelElements).not.toHaveBeenCalled();
    // A leg it declined to buy is not an answer. The candidate simply carries no preference.
    expect(answer.minutes).toBeNull();
    expect(answer.cause).toBe('not_cached');
  });

  it('counts the leg it declined, which is the cost question answered without paying it', async () => {
    const { driveLookupFor } = await import('../../booking/travel/routes.service');
    const onWouldSpend = vi.fn();

    await driveLookupFor(eligibility, 'sess-1', { cacheOnly: true, onWouldSpend })(leg);

    expect(onWouldSpend).toHaveBeenCalledTimes(1);
  });

  it('refuses to SPEND once the deadline has passed, even having started before it', async () => {
    // A race abandons the wait, not the work. A leg that starts at 1,999 ms of a 2,000 ms budget
    // would otherwise reserve an element and call Google long after the customer was answered -
    // money spent on an answer nobody will ever read. The check sits at the last moment where not
    // spending is still free: immediately before the reservation, after the cache read.
    const { driveLookupFor } = await import('../../booking/travel/routes.service');

    const answer = await driveLookupFor(eligibility, 'sess-1', { notAfter: Date.now() - 1 })(leg);

    expect(reserveTravelElements).not.toHaveBeenCalled();
    expect(answer.minutes).toBeNull();
  });

  it('still spends when the deadline is ahead of it', async () => {
    // The guard must not be permanently closed by a wrong comparison — that would silently turn
    // paid scoring back into the cache-only version this ticket exists to move away from.
    const { driveLookupFor } = await import('../../booking/travel/routes.service');
    reserveTravelElements.mockResolvedValue(false);

    await driveLookupFor(eligibility, 'sess-1', { notAfter: Date.now() + 60_000 })(leg);

    expect(reserveTravelElements).toHaveBeenCalledWith('tenant-1', 1);
  });

  it('leaves the feasibility caller buying legs exactly as before', async () => {
    // The whole mechanism must be invisible to the gate, or the fix costs more than the bug.
    const { driveLookupFor } = await import('../../booking/travel/routes.service');
    reserveTravelElements.mockResolvedValue(false);

    const answer = await driveLookupFor(eligibility, 'sess-1')(leg);

    expect(reserveTravelElements).toHaveBeenCalledWith('tenant-1', 1);
    expect(answer.cause).toBe('cap_exhausted');
  });
});
