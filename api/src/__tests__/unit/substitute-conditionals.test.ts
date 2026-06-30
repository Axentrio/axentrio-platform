import { describe, it, expect } from 'vitest';
import { substituteVariables } from '../../llm/compose-system-prompt';

const ai = (over: Record<string, unknown> = {}) =>
  ({ enabled: true, supportEmail: '', brandVoice: { name: 'Ava', tone: 'friendly' }, ...over }) as any;

describe('substituteVariables — {{#if}} conditional sections (AC17, L12)', () => {
  it('keeps the section and substitutes inside when the placeholder has a value', () => {
    const out = substituteVariables('{{#if supportEmail}}Support email: {supportEmail}{{/if}}', ai({ supportEmail: 'help@acme.test' }));
    expect(out).toBe('Support email: help@acme.test');
  });

  it('removes the whole section (no dangling label, no raw token) when the placeholder is empty', () => {
    const out = substituteVariables('{{#if supportEmail}}Support email: {supportEmail}{{/if}}', ai({ supportEmail: '' }));
    expect(out).toBe('');
    expect(out).not.toContain('Support email');
    expect(out).not.toContain('{supportEmail}');
  });

  it('still substitutes plain placeholders outside any conditional', () => {
    expect(substituteVariables('Hi from {botName}.', ai())).toBe('Hi from Ava.');
  });

  it('still preserves unknown placeholders verbatim (T10 unchanged)', () => {
    expect(substituteVariables('See {missingKey}.', ai())).toBe('See {missingKey}.');
  });

  it('drops a conditional keyed on an unknown/empty placeholder', () => {
    expect(substituteVariables('{{#if missingKey}}X{{/if}}Y', ai())).toBe('Y');
  });
});
