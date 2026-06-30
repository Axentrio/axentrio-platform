import { describe, it, expect } from 'vitest';
import { createBlockLedger, buildPromptTrace } from '../../llm/block-ledger';

describe('buildPromptTrace — merge composer ledger with agent.service module entries', () => {
  it('includes composer-included blocks plus MODULE_<id> for each active module', () => {
    const ledger = createBlockLedger(['kb_search']);
    ledger.include('KNOWLEDGE');
    const out = buildPromptTrace(ledger, { activeModuleIds: ['booking'] });
    expect(out.includedBlocks).toContain('KNOWLEDGE');
    expect(out.includedBlocks).toContain('MODULE_booking');
  });

  it('excludes composer-excluded blocks plus MODULE_<id> for expected-but-inactive modules (reason module)', () => {
    const ledger = createBlockLedger([]);
    ledger.exclude('KNOWLEDGE', 'toolAbsent');
    const out = buildPromptTrace(ledger, { activeModuleIds: [], expectedModuleIds: ['booking'] });
    expect(out.excludedBlocks).toContainEqual({ key: 'KNOWLEDGE', reason: 'toolAbsent' });
    expect(out.excludedBlocks).toContainEqual({ key: 'MODULE_booking', reason: 'module' });
  });

  it('does not record a module as both included and excluded (no-overlap union)', () => {
    const ledger = createBlockLedger([]);
    const out = buildPromptTrace(ledger, { activeModuleIds: ['booking'], expectedModuleIds: ['booking'] });
    expect(out.includedBlocks).toContain('MODULE_booking');
    expect(out.excludedBlocks.some((e) => e.key === 'MODULE_booking')).toBe(false);
  });

  // Composable-templates Phase 2 — the trace additively mirrors each module as a
  // SKILL_<id> in a SEPARATE field. MODULE_<id> stays untouched (analytics depend
  // on it); SKILL_ is purely additive and must never collide with it.
  it('mirrors each active module as SKILL_<id> in includedSkills, leaving MODULE_<id> untouched', () => {
    const ledger = createBlockLedger([]);
    const out = buildPromptTrace(ledger, { activeModuleIds: ['booking'] });
    expect(out.includedBlocks).toContain('MODULE_booking'); // legacy, unchanged
    expect(out.includedSkills).toContain('SKILL_booking'); // additive forward alias
    expect(out.includedBlocks).not.toContain('SKILL_booking'); // distinct arrays, no collision
  });

  it('mirrors expected-but-inactive modules as excluded SKILL_<id> (reason module)', () => {
    const ledger = createBlockLedger([]);
    const out = buildPromptTrace(ledger, { activeModuleIds: [], expectedModuleIds: ['booking'] });
    expect(out.excludedSkills).toContainEqual({ key: 'SKILL_booking', reason: 'module' });
    expect(out.excludedBlocks).toContainEqual({ key: 'MODULE_booking', reason: 'module' }); // legacy, unchanged
  });

  it('passes through allowedTools and the resolved template id/version', () => {
    const ledger = createBlockLedger(['kb_search', 'capture_lead']);
    const out = buildPromptTrace(ledger, { activeModuleIds: [], resolvedTemplateId: 'tpl-1', resolvedTemplateVersion: 3 });
    expect(out.allowedTools).toEqual(['kb_search', 'capture_lead']);
    expect(out.resolvedTemplateId).toBe('tpl-1');
    expect(out.resolvedTemplateVersion).toBe(3);
  });

  it('omits template id/version when unbound (null)', () => {
    const ledger = createBlockLedger([]);
    const out = buildPromptTrace(ledger, { activeModuleIds: [], resolvedTemplateId: null, resolvedTemplateVersion: null });
    expect(out.resolvedTemplateId).toBeUndefined();
    expect(out.resolvedTemplateVersion).toBeUndefined();
  });
});
