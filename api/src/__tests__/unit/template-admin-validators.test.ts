import { describe, it, expect } from 'vitest';
import {
  validateVariables,
  validateSelectedSkillIds,
  validateSkillProse,
  validateBody,
} from '../../templates/template-admin.service';

describe('validateVariables (template custom placeholders)', () => {
  it('accepts a well-formed variable and normalises fields', () => {
    const out = validateVariables([{ key: 'cancellationPolicy', label: 'Cancellation policy', required: true }]);
    expect(out).toEqual([{ key: 'cancellationPolicy', label: 'Cancellation policy', help: undefined, required: true, default: undefined }]);
  });

  it('rejects a built-in placeholder as a variable key (it would be a dead field)', () => {
    expect(() => validateVariables([{ key: 'businessName' }])).toThrow(/built-in placeholder/i);
  });

  it('rejects a duplicate key and a malformed key', () => {
    expect(() => validateVariables([{ key: 'x' }, { key: 'x' }])).toThrow(/duplicate/i);
    expect(() => validateVariables([{ key: 'has space' }])).toThrow(/placeholder name/i);
  });

  it('null/undefined → undefined (no change)', () => {
    expect(validateVariables(null)).toBeUndefined();
    expect(validateVariables(undefined)).toBeUndefined();
  });
});

describe('validateSelectedSkillIds', () => {
  it('dedupes and preserves order', () => {
    expect(validateSelectedSkillIds(['booking', 'handoff', 'booking'])).toEqual(['booking', 'handoff']);
  });
  it('rejects a non-string entry', () => {
    expect(() => validateSelectedSkillIds(['booking', 3 as unknown as string])).toThrow(/non-empty string/i);
  });
});

describe('validateSkillProse', () => {
  it('drops blank overrides (falls back to code default) and keeps real ones', () => {
    expect(validateSkillProse({ booking: 'Custom.', handoff: '   ' })).toEqual({ booking: 'Custom.' });
  });
});

describe('validateBody — declared variables are not "unknown"', () => {
  it('warns on an undeclared placeholder but not on a declared one', () => {
    expect(validateBody('Hi {businessName} — {cancellationPolicy}').warnings).toHaveLength(1); // cancellationPolicy undeclared
    expect(validateBody('Hi {businessName} — {cancellationPolicy}', ['cancellationPolicy']).warnings).toHaveLength(0);
  });
});
