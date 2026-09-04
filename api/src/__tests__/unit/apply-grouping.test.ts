/**
 * #82 (LP5) - the one function in the epic that changes what a customer sees.
 *
 * Everything else measures. This reorders, so the tests are about what it may NOT do at least as
 * much as what it may: the list that comes out has to be the same times as the list that went in,
 * and the sentence it produces has to be safe to put in front of a stranger.
 */
import { describe, it, expect } from 'vitest';
import { applyGrouping } from '../../booking/travel/apply-grouping';
import { counterfactualOrder } from '../../booking/travel/slot-ordering';
import type { ScoredCandidate } from '../../booking/travel/insertion-scorer';
import type { OfferScoring, SlotScore } from '../../booking/travel/score-offer';

const iso = (hhmm: string) => `2026-09-07T${hhmm}:00.000Z`;
const slot = (hhmm: string) => ({ start: iso(hhmm), end: iso(hhmm) });

const score = (costMinutes: number | null): SlotScore => ({
  costMinutes,
  neutralReason: costMinutes === null ? 'unanchored' : null,
  period: 'morning',
});

/** Cheapest is 15:00, so grouping wants it first even though 09:00 was offered first. */
const scoring = (over: Partial<OfferScoring> = {}): OfferScoring => ({
  scorerVersion: 'lp4-1',
  scores: { [iso('09:00')]: score(70), [iso('12:00')]: score(40), [iso('15:00')]: score(5) },
  counterfactualOrder: [iso('15:00'), iso('12:00'), iso('09:00')],
  cheaperAlternativeExisted: true,
  elementsSpent: 1,
  adjacentMisses: 0,
  estimatedLegs: 0,
  ms: 20,
  ...over,
});

const ON = { enabled: true, singleDay: true };

describe('what grouping is allowed to change', () => {
  it('puts the cheapest slot first when the owner has opted in', () => {
    const out = applyGrouping({ slots: [slot('09:00'), slot('12:00'), slot('15:00')], scoring: scoring(), ...ON });
    expect(out.slots.map((s) => s.start)).toEqual([iso('15:00'), iso('12:00'), iso('09:00')]);
    expect(out.applied?.savedMinutes).toBe(65);
  });

  it('offers exactly the same times, never a different set', () => {
    // The failure this guards shows up as a missing appointment slot rather than an exception:
    // the customer simply never sees a time they could have had, and nothing logs an error.
    const before = [slot('09:00'), slot('12:00'), slot('15:00')];
    const out = applyGrouping({ slots: before, scoring: scoring(), ...ON });
    expect([...out.slots.map((s) => s.start)].sort()).toEqual([...before.map((s) => s.start)].sort());
    expect(out.slots).toHaveLength(before.length);
  });

  it('leaves an unranked slot at the back instead of promoting it', () => {
    // A slot missing from the order must not sort to the front on a missing key, which is what a
    // bare `?? 0` would do - offering an unscored time ahead of every scored one.
    const out = applyGrouping({
      slots: [slot('09:00'), slot('12:00'), slot('15:00'), slot('17:00')],
      scoring: scoring(),
      ...ON,
    });
    expect(out.slots[out.slots.length - 1].start).toBe(iso('17:00'));
  });
});

describe('what grouping is not allowed to change', () => {
  it('does nothing at all while the owner has not opted in', () => {
    // The default for every Agent on the platform. LP4 keeps recording underneath, which is what
    // makes flipping this switch a measurement rather than a guess.
    const before = [slot('09:00'), slot('12:00'), slot('15:00')];
    const out = applyGrouping({ slots: before, scoring: scoring(), enabled: false, singleDay: true });
    expect(out.slots).toBe(before);
    expect(out.applied).toBeUndefined();
  });

  it('does nothing across a multi-day range', () => {
    // #82's own constraint. `check_availability` takes dates the MODEL chose, with no provenance,
    // so a wide range is not evidence the customer is free across it. Ranking Thursday above the
    // Tuesday they asked for would steer somebody who never agreed to be steered.
    const before = [slot('09:00'), slot('12:00'), slot('15:00')];
    const out = applyGrouping({ slots: before, scoring: scoring(), enabled: true, singleDay: false });
    expect(out.slots).toBe(before);
  });

  it('does nothing when the scorer had no opinion', () => {
    const before = [slot('09:00'), slot('12:00')];
    expect(applyGrouping({ slots: before, scoring: null, ...ON }).slots).toBe(before);
  });
});

describe('what the customer is told', () => {
  it('says nothing about another customer, their address, or their time', () => {
    // The truthful specifics are exactly the ones that are not this customer's to know. A booking
    // flow must not leak one customer's whereabouts to the next.
    const out = applyGrouping({ slots: [slot('09:00'), slot('15:00')], scoring: scoring(), ...ON });
    const said = out.applied!.customerReason!.toLowerCase();
    // Including that another customer EXISTS. An earlier draft said the time "fits with the other
    // work already booked in your area", which reveals a booking and roughly where it is - a leak
    // with no name on it is still a leak, and it contradicted the promise made in the portal.
    for (const leak of ['customer', 'address', 'street', 'booked', 'another', 'other work', 'your area']) {
      expect(said).not.toContain(leak);
    }
  });

  it('tells the OWNER about a reorder it does not explain to the customer', () => {
    // Both parties are told, and they are told differently. A silent reorder is still the platform
    // deciding on the owner's behalf, so it belongs in their audit trail even when the customer
    // hears nothing about it.
    const out = applyGrouping({
      slots: [slot('09:00'), slot('15:00')],
      scoring: scoring({
        scores: { [iso('09:00')]: score(12), [iso('15:00')]: score(8) },
        counterfactualOrder: [iso('15:00'), iso('09:00')],
      }),
      ...ON,
    });
    expect(out.applied?.savedMinutes).toBe(4);
    expect(out.applied?.reasonCode).toBe('no_preference');
    expect(out.applied?.customerReason).toBeUndefined();
  });

  it('reorders SILENTLY when the saving is too small to be worth a sentence', () => {
    // Telling somebody their preferred time is worse by four minutes gives them a reason to
    // distrust the next thing the bot says, and buys nothing.
    const out = applyGrouping({
      slots: [slot('09:00'), slot('15:00')],
      scoring: scoring({
        scores: { [iso('09:00')]: score(12), [iso('15:00')]: score(8) },
        counterfactualOrder: [iso('15:00'), iso('09:00')],
      }),
      ...ON,
    });
    expect(out.slots[0].start).toBe(iso('15:00'));
    expect(out.applied?.customerReason).toBeUndefined();
  });

  it('audits a TAIL-only reorder, where the first slot never moved', () => {
    // The narrow reading of "the order changed" is "the first one changed", and it leaves a real
    // reorder unaudited: the times below the first still moved around on the customer's screen.
    const out = applyGrouping({
      slots: [slot('15:00'), slot('09:00'), slot('12:00')],
      scoring: scoring(),
      ...ON,
    });
    expect(out.slots.map((s) => s.start)).toEqual([iso('15:00'), iso('12:00'), iso('09:00')]);
    expect(out.applied).toBeDefined();
    // Nothing to explain though - the slot offered first is the one that was already first, so
    // from the customer's side nothing was traded away.
    expect(out.applied?.savedMinutes).toBe(0);
    expect(out.applied?.customerReason).toBeUndefined();
  });

  it('says nothing when the order did not actually change', () => {
    // Already in the order grouping wanted, so nothing moved and there is nothing to record.
    const out = applyGrouping({
      slots: [slot('15:00'), slot('12:00'), slot('09:00')],
      scoring: scoring(),
      ...ON,
    });
    expect(out.applied).toBeUndefined();
  });
});

describe('counterfactualOrder still hands applyGrouping a permutation', () => {
  const scored: ScoredCandidate[] = [
    { start: new Date(iso('09:00')), costMinutes: 70, neutralReason: null, period: 'morning' },
    { start: new Date(iso('12:00')), costMinutes: null, neutralReason: 'unanchored', period: 'morning' },
    { start: new Date(iso('15:00')), costMinutes: 5, neutralReason: null, period: 'morning' },
  ];

  it('keeps the same Slot identities', () => {
    const before = [slot('09:00'), slot('12:00'), slot('15:00')];
    const order = counterfactualOrder({ scored, requestable: [] });
    const out = applyGrouping({
      slots: before,
      scoring: scoring({ counterfactualOrder: order }),
      ...ON,
    });
    expect([...out.slots.map((s) => s.start)].sort()).toEqual([...before.map((s) => s.start)].sort());
    expect(out.slots).toHaveLength(before.length);
  });
});
