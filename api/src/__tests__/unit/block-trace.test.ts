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
