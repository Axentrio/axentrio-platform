import { describe, it, expect } from 'vitest';
import { validateModuleProse, validateSelectedModuleRefs } from '../../templates/template-admin.service';
import { selectSkillIds } from '../../templates/template-resolver';
import { validateSkillIds } from '../../templates/module-admin.service';

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

describe('validateSelectedModuleRefs — well-formed refs or the legacy path', () => {
  it('null/undefined → undefined (use expectedModules)', () => {
    expect(validateSelectedModuleRefs(null)).toBeUndefined();
    expect(validateSelectedModuleRefs(undefined)).toBeUndefined();
  });

  it('accepts well-formed refs', () => {
    expect(validateSelectedModuleRefs([{ moduleId: 'm1', moduleVersion: 2 }])).toEqual([
      { moduleId: 'm1', moduleVersion: 2 },
    ]);
  });

  it('rejects malformed refs', () => {
    expect(() => validateSelectedModuleRefs('x')).toThrow();
    expect(() => validateSelectedModuleRefs([{ moduleId: 'm1' }])).toThrow(/moduleVersion/i);
    expect(() => validateSelectedModuleRefs([{ moduleId: '', moduleVersion: 1 }])).toThrow(/moduleId/i);
  });
});

describe('validateSkillIds — one or more known skills (deduped)', () => {
  it('accepts a single known catalog skill', () => {
    expect(validateSkillIds(['booking'])).toEqual(['booking']);
  });

  it('accepts multiple known skills', () => {
    expect(validateSkillIds(['booking', 'lead_capture', 'handoff'])).toEqual(['booking', 'lead_capture', 'handoff']);
  });

  it('dedupes repeated skills', () => {
    expect(validateSkillIds(['booking', 'booking'])).toEqual(['booking']);
  });

  it('rejects an unknown skill id', () => {
    expect(() => validateSkillIds(['nope'])).toThrow(/unknown skill/i);
  });

  it('rejects binding zero skills', () => {
    expect(() => validateSkillIds([])).toThrow(/at least one/i);
  });
});
