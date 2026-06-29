// L10/Phase 4 — pure agent-mode preview: compile a template under a mock runtime
// context (tier / activeModules / channel) and return the block ledger, with no LLM
// call and no live tenant/bot. The base-mode test-chat is untouched. Mock tier/modules
// bypass entitlement checks, so this is a what-if, not a guarantee the live ledger matches.
import { composeSystemPrompt } from '../llm/compose-system-prompt';
import type { ExcludedBlock } from '../llm/block-ledger';

export type PreviewTier = 'free' | 'essential' | 'pro' | 'enterprise';

export interface PreviewLedgerResult {
  prompt: string;
  scope: 'customer_reply';
  includedBlocks: string[];
  excludedBlocks: ExcludedBlock[];
  allowedTools: string[];
}

export function previewLedger(opts: {
  body: string;
  tone?: string;
  topicsToAvoid?: string[];
  maxResponseLength?: number;
  tier?: PreviewTier;
  channel?: string;
  activeModules?: string[];
}): PreviewLedgerResult {
  const ai = {
    enabled: true,
    brandVoice: { name: 'Assistant', tone: opts.tone || 'friendly', customInstructions: '' },
    guardrails: {
      topicsToAvoid: opts.topicsToAvoid ?? [],
      maxResponseLength: opts.maxResponseLength ?? 500,
      escalationKeywords: [],
    },
  } as never;

  const activeModules = opts.activeModules ?? [];
  // Synthetic tools for the mock context (what L10 names — not full module tooling):
  // core always; lead-capture when the tier is entitled (≠ free); booking tools when
  // the booking module is mock-active.
  const toolNames = ['kb_search', 'escalate_to_human'];
  if (opts.tier && opts.tier !== 'free') toolNames.push('capture_lead');
  if (activeModules.includes('booking')) toolNames.push('create_booking', 'check_availability', 'request_appointment');

  const { prompt, ledger } = composeSystemPrompt({
    mode: 'agent',
    ai,
    tenantName: 'Your Business',
    tier: opts.tier,
    tools: toolNames.map((name) => ({ name })) as never,
    channel: opts.channel ?? 'widget',
    templateBody: opts.body,
    bookingConfigured: activeModules.includes('booking'),
  });

  return {
    prompt,
    scope: 'customer_reply',
    includedBlocks: ledger.getIncluded(),
    excludedBlocks: ledger.getExcluded(),
    allowedTools: ledger.getAllowedTools(),
  };
}
