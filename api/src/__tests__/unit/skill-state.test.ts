import { describe, it, expect } from 'vitest';
import { EXCLUSION_REASONS } from '../../llm/block-ledger';
import { SKILL_STATES, type SkillResolution } from '../../modules/skill-state';

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
