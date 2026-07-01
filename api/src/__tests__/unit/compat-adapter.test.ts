import { describe, it, expect } from 'vitest';
import { adaptLegacyModule, adaptExpectedModules } from '../../modules/compat-adapter';
import type { ModuleDefinition } from '../../modules/module-catalog';

// Composable-templates Phase 2 — the compat adapter represents today's engineered
// modules + a template's expectedModules in the new vocabulary (skills + single-
// skill modules) losslessly and in-memory. Correct iff nothing is dropped.

const fakeModule = (over: Partial<ModuleDefinition> = {}): ModuleDefinition => ({
  id: 'booking',
  displayName: 'Booking',
  gate: { kind: 'feature', feature: 'bookings' as any },
  tools: [{ name: 'create_booking' } as any],
  buildPromptSection: async () => 'SERVICES',
  ...over,
});

describe('compat-adapter — represent today as skills, losslessly', () => {
  it('adaptLegacyModule preserves id/displayName/gate/tools/buildPromptSection', () => {
    const def = fakeModule();
    const skill = adaptLegacyModule(def);
    expect(skill.id).toBe('booking');
    expect(skill.displayName).toBe('Booking');
    expect(skill.gate).toEqual(def.gate);
    expect(skill.tools).toBe(def.tools); // same adapters, not copied
    expect(skill.buildPromptSection).toBe(def.buildPromptSection);
  });

  it('adaptExpectedModules makes one single-skill module ref per expected module id', () => {
    expect(adaptExpectedModules(['booking', 'knowledge'])).toEqual([
      { moduleId: 'booking', skillIds: ['booking'] },
      { moduleId: 'knowledge', skillIds: ['knowledge'] },
    ]);
  });

  it('dedups repeated module ids (no phantom duplicate refs)', () => {
    expect(adaptExpectedModules(['booking', 'booking'])).toEqual([
      { moduleId: 'booking', skillIds: ['booking'] },
    ]);
  });

  it('empty expectedModules → no refs', () => {
    expect(adaptExpectedModules([])).toEqual([]);
  });
});
