/**
 * Who may analyse, when.
 *
 * The tier bands are read from feature FLAGS rather than tier names, so these tests use
 * flag combinations — that is the contract a super-admin override or a mid-cycle plan
 * change actually travels through.
 */
import { describe, it, expect } from 'vitest';
import {
  analysisPolicyFor,
  checkEligibility,
  insightsTierOf,
} from '../../insights/analysis-policy';
import type { PlanFeatures } from '../../billing/types';

/** Only the three flags that decide the band; the rest never affect it. */
const features = (o: Partial<PlanFeatures>): PlanFeatures =>
  ({ gapInsights: false, gapEvidence: false, aiBusinessInsights: false, ...o }) as PlanFeatures;

const FREE = features({});
const ESSENTIAL = features({ gapInsights: true });
const PRO = features({ gapInsights: true, gapEvidence: true });
const ENTERPRISE = features({ gapInsights: true, gapEvidence: true, aiBusinessInsights: true });

const NOW = new Date('2026-08-03T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('insightsTierOf — bands come from flags, not tier names', () => {
  it('maps each flag combination to its band', () => {
    expect(insightsTierOf(FREE)).toBe('none');
    expect(insightsTierOf(ESSENTIAL)).toBe('essential');
    expect(insightsTierOf(PRO)).toBe('pro');
    expect(insightsTierOf(ENTERPRISE)).toBe('enterprise');
  });

  it('treats a granted flag as the band, however it was granted', () => {
    // A super-admin override grants the flag without changing the plan. If this read a
    // tier name the override would silently do nothing.
    expect(insightsTierOf(features({ gapInsights: true, aiBusinessInsights: true }))).toBe(
      'enterprise',
    );
  });
});

describe('analysisPolicyFor — the tiers differ in HOW analysis runs', () => {
  it('gives Essential the loosest data bar and the longest cooldown', () => {
    const p = analysisPolicyFor(ESSENTIAL);
    expect(p).toMatchObject({ automatic: false, minNewChats: 15, cooldownHours: 72 });
  });

  it('lets Pro analyse sooner, and more often', () => {
    const p = analysisPolicyFor(PRO);
    expect(p).toMatchObject({ automatic: false, minNewChats: 8, cooldownHours: 24 });
    expect(p.minNewChats).toBeLessThan(analysisPolicyFor(ESSENTIAL).minNewChats);
    expect(p.cooldownHours).toBeLessThan(analysisPolicyFor(ESSENTIAL).cooldownHours);
  });

  it('runs Enterprise automatically, with no button and no cooldown', () => {
    expect(analysisPolicyFor(ENTERPRISE)).toMatchObject({ automatic: true, cooldownHours: 0 });
  });
});

describe('checkEligibility', () => {
  const run = (f: PlanFeatures, newChats: number, lastManualRunAt: Date | null = null) =>
    checkEligibility({ policy: analysisPolicyFor(f), newChats, lastManualRunAt, now: NOW });

  it('allows a first run once the minimum is met', () => {
    expect(run(ESSENTIAL, 15)).toMatchObject({ eligible: true, reason: null });
    expect(run(PRO, 8)).toMatchObject({ eligible: true, reason: null });
  });

  it('refuses below the minimum — an insight from three chats is noise', () => {
    expect(run(ESSENTIAL, 14)).toMatchObject({ eligible: false, reason: 'not_enough_chats' });
    expect(run(PRO, 7)).toMatchObject({ eligible: false, reason: 'not_enough_chats' });
  });

  it('refuses inside the cooldown even with plenty of new conversations', () => {
    // The two limits protect different things: the minimum protects the OUTPUT, the
    // cooldown protects the BILL. Having enough data does not buy a second run.
    const r = run(ESSENTIAL, 500, hoursAgo(71));
    expect(r).toMatchObject({ eligible: false, reason: 'cooling_down' });
    // Ran 71h ago with a 72h cooldown ⇒ one hour left, not a fresh 72.
    expect(r.nextAllowedAt?.toISOString()).toBe('2026-08-03T13:00:00.000Z');
  });

  it('allows the run again once the cooldown has passed', () => {
    expect(run(ESSENTIAL, 15, hoursAgo(73))).toMatchObject({ eligible: true });
    expect(run(PRO, 8, hoursAgo(25))).toMatchObject({ eligible: true });
    // …and Pro's shorter cooldown is the whole difference at 25 hours.
    expect(run(ESSENTIAL, 15, hoursAgo(25))).toMatchObject({ reason: 'cooling_down' });
  });

  it('reports BOTH limits even when the first already fails', () => {
    // So the portal can say "12 of 15, and you could run again in 4 hours" rather than
    // revealing one obstacle, then the next.
    const r = run(ESSENTIAL, 12, hoursAgo(68));
    expect(r.newChats).toBe(12);
    expect(r.minNewChats).toBe(15);
    expect(r.nextAllowedAt).not.toBeNull();
  });

  it('never offers the button to Enterprise — analysis is already continuous', () => {
    expect(run(ENTERPRISE, 9999)).toMatchObject({ eligible: false, reason: 'automatic' });
  });

  it('refuses a tenant without insights at all, before any counting', () => {
    expect(run(FREE, 9999)).toMatchObject({ eligible: false, reason: 'not_entitled' });
  });
});
