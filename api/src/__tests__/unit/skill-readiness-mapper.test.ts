import { describe, it, expect } from 'vitest';
import { resolveSkillStates, type SkillState } from '../../modules/skill-state';
import {
  readinessRefinement,
  safeReadiness,
  skillStateToRemedy,
  skillStatesToReadiness,
  BOOKING_SKILL_ID,
} from '../../llm/skill-readiness';
import type { SkillRemedy } from '../../contracts/skill-readiness';

// Composable-templates Phase 6 — PURE state-machine + remedy mapper. No DB, no
// HTTP, no mocks: resolveSkillStates + readinessRefinement + safeReadiness +
// skillStateToRemedy with hard-coded gateKind/readiness closures, exactly as the
// readiness endpoint (modules/bot-skill-readiness.ts) wires them. The endpoint's
// integration is exercised elsewhere; this locks the logic the spec depends on.

/** Resolve just the booking skill the way the endpoint does, with injected ctx. */
function bookingState(opts: {
  active: boolean; // booking entitled-and-active (in the resolver's `active` set)
  gateKind?: 'feature' | 'enablement' | undefined;
  bookingConfigured?: boolean;
  readinessThrows?: boolean;
}): SkillState {
  const states = resolveSkillStates({
    selected: [BOOKING_SKILL_ID],
    active: opts.active ? [BOOKING_SKILL_ID] : [],
    gateKind: () => (opts.gateKind === undefined ? 'feature' : opts.gateKind),
    readiness: safeReadiness((id) => {
      if (opts.readinessThrows) throw new Error('readiness boom');
      return readinessRefinement(id, { bookingConfigured: opts.bookingConfigured ?? false });
    }),
  });
  return states[BOOKING_SKILL_ID];
}

describe('skillStateToRemedy — state → tenant remedy (single source of truth)', () => {
  const cases: [SkillState, SkillRemedy][] = [
    ['ready', null],
    ['unentitled', 'upgrade'],
    ['disabled', 'turn on'],
    ['unconfigured', 'finish setup'],
    ['absent', null],
    ['error', null],
  ];
  it.each(cases)('%s → %s', (state, remedy) => {
    expect(skillStateToRemedy(state)).toBe(remedy);
  });
});

describe('booking skill state across the resolver + readiness refinement', () => {
  it('Case 1 — Pro tenant, selected + active, configured → ready (remedy null)', () => {
    const state = bookingState({ active: true, bookingConfigured: true });
    expect(state).toBe('ready');
    expect(skillStateToRemedy(state)).toBeNull();
  });

  it("Case 2 — selected + active but NOT configured → unconfigured (remedy 'finish setup')", () => {
    const state = bookingState({ active: true, bookingConfigured: false });
    expect(state).toBe('unconfigured');
    expect(skillStateToRemedy(state)).toBe('finish setup');
  });

  it("Case 3 — feature-gated, selected but not active (free tier) → unentitled (remedy 'upgrade')", () => {
    const state = bookingState({ active: false, gateKind: 'feature' });
    expect(state).toBe('unentitled');
    expect(skillStateToRemedy(state)).toBe('upgrade');
  });

  it("enablement-gated, selected but not active → disabled (remedy 'turn on')", () => {
    const state = bookingState({ active: false, gateKind: 'enablement' });
    expect(state).toBe('disabled');
    expect(skillStateToRemedy(state)).toBe('turn on');
  });

  it('Case 4 — selected with an unknown gate (not offered) → absent, omitted from the response', () => {
    const states = resolveSkillStates({
      selected: ['mystery_skill'],
      active: [],
      gateKind: () => undefined,
    });
    expect(states['mystery_skill']).toBe('absent');
    // absent is silent — never surfaced to the tenant
    expect(skillStatesToReadiness(states, (id) => id)).toEqual([]);
  });

  it('Case 5 — readiness refinement throws → error (remedy null, fail-safe contained to the skill)', () => {
    const state = bookingState({ active: true, readinessThrows: true });
    expect(state).toBe('error');
    expect(skillStateToRemedy(state)).toBeNull();
  });
});

describe('skillStatesToReadiness — DTO assembly', () => {
  it('maps states → {id,name,state,remedy}, names via the lookup, omits absent', () => {
    const dtos = skillStatesToReadiness(
      { booking: 'unconfigured', mystery: 'absent', other: 'ready' },
      (id) => (id === 'booking' ? 'Bookings' : id),
    );
    expect(dtos).toEqual([
      { id: 'booking', name: 'Bookings', state: 'unconfigured', remedy: 'finish setup' },
      { id: 'other', name: 'other', state: 'ready', remedy: null },
    ]);
  });
});
