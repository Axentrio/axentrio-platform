import { describe, it, expect } from 'vitest';
import { validateModuleProse } from '../../templates/template-admin.service';
import { selectSkillIds } from '../../templates/template-resolver';

// Composable-templates Phase 4 — authored-module guards.
// validateModuleProse: prose carries workflow INTENT only, never tool claims (the
// guard against a module promising things the bound skill can't honestly do).
// selectSkillIds: a template's selected module refs → bound skill ids, with a
// lossless fallback to the legacy expectedModules path.

describe('validateModuleProse — no tool-availability claims', () => {
  it('accepts plain workflow-intent prose', () => {
    const ok = 'Greet the customer warmly, understand what they need, and offer the next available appointment.';
    expect(validateModuleProse(ok)).toContain('Greet');
  });

  it('rejects prose that names a tool directly', () => {
    expect(() => validateModuleProse('Then call create_booking to confirm the slot.')).toThrow(/tool/i);
  });

  it('rejects "use the X tool" phrasing', () => {
    expect(() => validateModuleProse('Use the booking tool to schedule them in.')).toThrow(/tool/i);
  });

  it('rejects non-string input', () => {
    expect(() => validateModuleProse(42 as unknown)).toThrow();
  });
});

describe('selectSkillIds — selected modules → skills, fallback to expectedModules', () => {
  it('falls back to expectedModules (deduped) when there are no refs', () => {
    expect(selectSkillIds({ expectedModules: ['booking', 'booking'] }, () => [])).toEqual(['booking']);
  });

  it('resolves module refs to their bound skills, deduped and order-stable', () => {
    const moduleSkills = (id: string) =>
      id === 'm1' ? ['booking'] : id === 'm2' ? ['booking', 'knowledge'] : [];
    expect(
      selectSkillIds(
        { selectedModuleRefs: [{ moduleId: 'm1' }, { moduleId: 'm2' }], expectedModules: ['ignored'] },
        moduleSkills,
      ),
    ).toEqual(['booking', 'knowledge']);
  });

  it('treats an empty refs array as "no refs" (uses expectedModules)', () => {
    expect(selectSkillIds({ selectedModuleRefs: [], expectedModules: ['booking'] }, () => [])).toEqual(['booking']);
  });
});
