// Template layer (layer 2) wiring into composeSystemPrompt (Phase 2,
// .scratch/plan-bot-templates.md). Empty/absent templateBody is covered by the
// characterization snapshots (byte-identical); these lock the NON-empty cases.
import { describe, it, expect } from 'vitest';
import { composeSystemPrompt } from '../../llm/compose-system-prompt';
import type { Tenant } from '../../database/entities/Tenant';

type AiSettings = NonNullable<NonNullable<Tenant['settings']>['ai']>;

const ai = {
  enabled: true,
  brandVoice: { name: 'Ava', tone: 'friendly', customInstructions: 'CUSTOM_MARKER for {businessName}.' },
  guardrails: { topicsToAvoid: [], escalationKeywords: [], confidenceThreshold: 0.7, maxResponseLength: 500, greetingMessage: '', fallbackMessage: '', offHoursMessage: '' },
} as unknown as AiSettings;

const aiNoCustom = {
  ...ai,
  brandVoice: { name: 'Ava', tone: 'friendly', customInstructions: '' },
} as unknown as AiSettings;

describe('agent mode — template layer', () => {
  it('inserts the template body after Tone and before custom instructions, substituted', () => {
    const out = composeSystemPrompt({
      mode: 'agent', ai, tenantName: 'Acme', tools: [],
      templateBody: 'TEMPLATE_MARKER serving {businessName}.',
    });
    const idxTone = out.indexOf('Tone: friendly');
    const idxTemplate = out.indexOf('TEMPLATE_MARKER');
    const idxCustom = out.indexOf('CUSTOM_MARKER');
    expect(idxTone).toBeGreaterThanOrEqual(0);
    expect(idxTemplate).toBeGreaterThan(idxTone);
    expect(idxCustom).toBeGreaterThan(idxTemplate);
    expect(out).toContain('TEMPLATE_MARKER serving Acme.');
  });

  it('empty template body contributes nothing (custom still present)', () => {
    const out = composeSystemPrompt({ mode: 'agent', ai, tenantName: 'Acme', tools: [], templateBody: '' });
    expect(out).toContain('CUSTOM_MARKER for Acme.');
    expect(out).not.toContain('TEMPLATE_MARKER');
  });
});

describe('base mode — template layer', () => {
  it('combines template then custom under TENANT INSTRUCTIONS', () => {
    const out = composeSystemPrompt({ mode: 'base', ai, businessName: 'Acme', templateBody: 'TEMPLATE_MARKER.' });
    const idxHeading = out.indexOf('## TENANT INSTRUCTIONS');
    const idxTemplate = out.indexOf('TEMPLATE_MARKER.');
    const idxCustom = out.indexOf('CUSTOM_MARKER');
    const idxRules = out.indexOf('## PLATFORM RULES');
    expect(idxTemplate).toBeGreaterThan(idxHeading);
    expect(idxCustom).toBeGreaterThan(idxTemplate);
    expect(idxRules).toBeGreaterThan(idxCustom);
  });

  it('template-only (no custom) shows the template, not the default block', () => {
    const out = composeSystemPrompt({ mode: 'base', ai: aiNoCustom, businessName: 'Acme', templateBody: 'TEMPLATE_MARKER.' });
    expect(out).toContain('TEMPLATE_MARKER.');
    expect(out).not.toContain('Answer visitor questions clearly and concisely');
  });

  it('empty template AND empty custom falls back to the default block', () => {
    const out = composeSystemPrompt({ mode: 'base', ai: aiNoCustom, businessName: 'Acme', templateBody: '' });
    expect(out).toContain('Answer visitor questions clearly and concisely');
  });
});

describe('rag mode — template layer', () => {
  it('includes the template body in the tenant instructions, before the KB rules', () => {
    const out = composeSystemPrompt({ mode: 'rag', ai, businessName: 'Acme', knowledgeContext: 'KB', templateBody: 'TEMPLATE_MARKER.' });
    const idxTemplate = out.indexOf('TEMPLATE_MARKER.');
    const idxKbRules = out.indexOf('## KNOWLEDGE BASE RULES');
    expect(idxTemplate).toBeGreaterThanOrEqual(0);
    expect(idxKbRules).toBeGreaterThan(idxTemplate);
  });
});

describe('n8n mode — template layer', () => {
  it('joins template + custom (substituted), no platform rules', () => {
    const out = composeSystemPrompt({ mode: 'n8n', ai, businessName: 'Acme', templateBody: 'TEMPLATE_MARKER.' });
    expect(out).toBe('TEMPLATE_MARKER.\n\nCUSTOM_MARKER for Acme.');
    expect(out).not.toContain('## PLATFORM RULES');
  });

  it('empty template + empty custom → empty string (n8n contract)', () => {
    const out = composeSystemPrompt({ mode: 'n8n', ai: aiNoCustom, businessName: 'Acme', templateBody: '' });
    expect(out).toBe('');
  });

  it('template-only (no custom) → just the template', () => {
    const out = composeSystemPrompt({ mode: 'n8n', ai: aiNoCustom, businessName: 'Acme', templateBody: 'TEMPLATE_MARKER.' });
    expect(out).toBe('TEMPLATE_MARKER.');
  });
});
