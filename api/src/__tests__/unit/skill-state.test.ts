import { describe, it, expect } from 'vitest';
import { EXCLUSION_REASONS } from '../../llm/block-ledger';
import { SKILL_STATES, resolveSkillStates, type SkillResolution } from '../../modules/skill-state';

// Composable-templates Phase 1 — lock the canonical SkillState machine and the
// ledger ExclusionReason set as committed, runtime-introspectable contracts.
// These are the source of truth Phases 3-6 read. This test fails loudly if a
// member is removed (which would break existing ledger consumers) or the set
// drifts from the approved spec (.scratch/plan-composable-templates-implementation.md).

describe('composable-templates Phase 1 — committed type contracts', () => {
  it('ExclusionReason keeps the original 7 reasons and adds the 5 skill-state reasons', () => {
    expect([...EXCLUSION_REASONS].sort()).toEqual(
      [
        // original — must NEVER be removed; existing ledger consumers depend on them
        'toolAbsent', 'channel', 'tier', 'bookingConfigured', 'empty', 'module', 'specialty',
        // added for the skill-state machine
        'unentitled', 'disabled', 'unconfigured', 'error', 'absent',
      ].sort(),
    );
  });

  it('SkillState has exactly the six resolver states', () => {
    expect([...SKILL_STATES].sort()).toEqual(
      ['ready', 'unentitled', 'disabled', 'unconfigured', 'absent', 'error'].sort(),
    );
  });

  it('SkillResolution is constructible from an id + state', () => {
    const r: SkillResolution = { id: 'booking', state: 'unconfigured' };
    expect(r.state).toBe('unconfigured');
  });
});

// Phase 3a — pure resolver: maps (selected ∪ active) skills + gate kind + an
// optional readiness refinement to a state. Pure (no DB) so the state machine is
// unit-tested in isolation; agent.service feeds it already-resolved locals.
describe('resolveSkillStates — entitlement/enablement (+ readiness) → state', () => {
  const gateKind = (id: string) =>
    id === 'booking' ? ('feature' as const) : id === 'bespoke' ? ('enablement' as const) : undefined;

  it('active skill, no readiness refinement → ready', () => {
    expect(resolveSkillStates({ selected: ['booking'], active: ['booking'], gateKind }).booking).toBe('ready');
  });

  it('active booking refined by readiness → unconfigured', () => {
    const readiness = (id: string) => (id === 'booking' ? ('unconfigured' as const) : undefined);
    expect(resolveSkillStates({ selected: ['booking'], active: ['booking'], gateKind, readiness }).booking).toBe('unconfigured');
  });

  it('selected feature-gated skill, not active → unentitled', () => {
    expect(resolveSkillStates({ selected: ['booking'], active: [], gateKind }).booking).toBe('unentitled');
  });

  it('selected enablement-gated skill, not active → disabled', () => {
    expect(resolveSkillStates({ selected: ['bespoke'], active: [], gateKind }).bespoke).toBe('disabled');
  });

  it('unknown skill id → absent', () => {
    expect(resolveSkillStates({ selected: ['mystery'], active: [], gateKind }).mystery).toBe('absent');
  });

  it('readiness never upgrades a non-ready base state', () => {
    const readiness = () => 'ready' as const; // even if a readiness check says ready...
    // ...an unentitled skill stays unentitled (entitlement is the hard ceiling).
    expect(resolveSkillStates({ selected: ['booking'], active: [], gateKind, readiness }).booking).toBe('unentitled');
  });
});
