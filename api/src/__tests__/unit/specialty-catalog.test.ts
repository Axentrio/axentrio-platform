import { describe, it, expect } from 'vitest';
import {
  SPECIALTY_CATALOG,
  SPECIALTY_PROMPT_BLOCKS,
  specialtiesForVertical,
  effectiveSelectedSpecialties,
  resolveSpecialties,
  specialtyRetrievalTerms,
} from '../../llm/specialty-catalog';

describe('SpecialtyCatalog (S1)', () => {
  it('catalog self-check: unique businessType+specialtyKey; every requiresSpecialPrompt resolves a block', () => {
    const seen = new Set<string>();
    for (const s of SPECIALTY_CATALOG) {
      const k = `${s.businessType}/${s.specialtyKey}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      if (s.requiresSpecialPrompt) {
        expect(s.relatedPromptBlockId).toBeTruthy();
        expect(SPECIALTY_PROMPT_BLOCKS[s.relatedPromptBlockId!]).toBeTruthy();
      }
    }
  });

  it('specialtiesForVertical filters by category and is empty for unknown/null', () => {
    expect(specialtiesForVertical('plumber').length).toBeGreaterThan(0);
    expect(specialtiesForVertical('hairdresser')).toEqual([]);
    expect(specialtiesForVertical(null)).toEqual([]);
  });

  it('effectiveSelectedSpecialties: explicit selection wins; default fallback excludes exception-prompt specialties (S6)', () => {
    expect(effectiveSelectedSpecialties(['emergency'], 'plumber').map((s) => s.specialtyKey)).toEqual(['emergency']);
    const fallback = effectiveSelectedSpecialties(undefined, 'plumber');
    expect(fallback.every((s) => s.defaultEnabled && !s.requiresSpecialPrompt)).toBe(true);
    expect(fallback.some((s) => s.specialtyKey === 'emergency')).toBe(false);
  });

  it('resolveSpecialties resolves block text only for requiresSpecialPrompt specialties', () => {
    const r = resolveSpecialties(specialtiesForVertical('plumber'));
    const emergency = r.find((s) => s.key === 'emergency')!;
    expect(emergency.requiresSpecialPrompt).toBe(true);
    expect(emergency.block).toContain('EMERGENCY');
    expect(r.find((s) => s.key === 'leaks')!.block).toBeNull();
  });

  it('specialtyRetrievalTerms flattens aliases + tags, deduped', () => {
    const terms = specialtyRetrievalTerms(specialtiesForVertical('plumber'));
    expect(terms).toContain('leak');
    expect(terms).toContain('drain');
    expect(new Set(terms).size).toBe(terms.length);
  });
});
