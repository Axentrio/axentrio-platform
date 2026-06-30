import { describe, it, expect } from 'vitest';
import { INTERNAL_BLOCK_KEYS, createBlockLedger, buildPromptTrace } from '../../llm/block-ledger';
import { composeSystemPrompt } from '../../llm/compose-system-prompt';

describe('prompt scope guard (L13, AC10/15/16)', () => {
  it('INTERNAL_BLOCK_KEYS is empty in v1 — no internal-scope blocks exist for the customer composer', () => {
    expect(INTERNAL_BLOCK_KEYS).toEqual([]);
  });

  it('a customer_reply agent composition includes ZERO internal-scope block keys (fails loudly if one is ever added to the agent path)', () => {
    const { ledger } = composeSystemPrompt({
      mode: 'agent',
      ai: { enabled: true } as any,
      tenantName: 'Acme',
      tools: [{ name: 'kb_search' } as any, { name: 'capture_lead' } as any, { name: 'escalate_to_human' } as any],
    });
    const leaked = ledger.getIncluded().filter((k) => (INTERNAL_BLOCK_KEYS as readonly string[]).includes(k));
    expect(leaked).toEqual([]);
  });

  it('buildPromptTrace tags the record as customer_reply scope', () => {
    const out = buildPromptTrace(createBlockLedger([]), { activeModuleIds: [] });
    expect(out.scope).toBe('customer_reply');
  });
});
