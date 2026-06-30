// Block ledger — the auditable record of which prompt blocks each agent turn
// received and why. Produced by composeSystemPrompt (agent mode) and persisted
// on AgentTrace, so a superadmin can see exactly what the AI was given.
//
// Honesty rule: the composer only records what it can OBSERVE (the resolved tool
// list + the conditional sections it assembles). Upstream gating reasons (plan /
// feature / tenant-toggle) are NOT inferred here — the trace separately stores
// allowedTools + activeModules. MODULE_<id> entries are owned by agent.service
// (the composer is handed module sections as opaque strings); SPECIALTY_<key> is
// added by the SpecialtyCatalog work. See plan-dynamic-prompt-builder.md L5–L7.

export type ExclusionReason =
  | 'toolAbsent'
  | 'channel'
  | 'tier'
  | 'bookingConfigured'
  | 'empty'
  | 'module'
  | 'specialty';

export interface ExcludedBlock {
  key: string;
  reason: ExclusionReason;
}

// Canonical ledger block keys — the composition's vocabulary. Impl and tests
// reference these, never bare string literals, so they can't drift.
// MODULE_<id> and SPECIALTY_<key> are dynamic families recorded outside the
// composer and so are not listed here.
export const PROMPT_BLOCK_KEYS = {
  TEMPLATE_BODY: 'TEMPLATE_BODY',
  CUSTOM_INSTRUCTIONS: 'CUSTOM_INSTRUCTIONS',
  EXTRA_INFO: 'EXTRA_INFO',
  CUSTOMER_NAME: 'CUSTOMER_NAME',
  KNOWLEDGE: 'KNOWLEDGE',
  CONTACT_DETAILS: 'CONTACT_DETAILS',
  CHANNEL_LEAD_CAPTURE: 'CHANNEL_LEAD_CAPTURE',
  SOCIAL_SHORT_REPLY: 'SOCIAL_SHORT_REPLY',
  ESCALATION: 'ESCALATION',
  BOOKING: 'BOOKING',
  AVAILABLE_SKILLS: 'AVAILABLE_SKILLS',
  KB_CONTEXT: 'KB_CONTEXT',
} as const;

// L13 (AC10/15/16): keys that must NEVER appear in a customer_reply composition
// (CRM-sync, AI-insights, platform-assistant blocks). Empty in v1 — no such block
// exists for the agent composer, and internal tasks (copilot, insights, CRM) use
// their own composers. The scope-guard test asserts a customer_reply build's
// included blocks ∩ INTERNAL_BLOCK_KEYS === ∅, so it fails loudly if a future
// internal block is ever routed through the agent path.
export const INTERNAL_BLOCK_KEYS: readonly string[] = [];

export interface BlockLedger {
  include(key: string): void;
  exclude(key: string, reason: ExclusionReason): void;
  getIncluded(): string[];
  getExcluded(): ExcludedBlock[];
  getAllowedTools(): string[];
}

/** The ledger payload persisted on AgentTrace.trace (jsonb) — the auditable
 *  record of which blocks the customer prompt received and why. Assembled from
 *  the composer ledger PLUS agent.service's module entries (composer-owned keys
 *  + agent.service-owned MODULE_<id> keys form a no-overlap union, L7). */
export interface PromptTrace {
  /** Composition scope (L13). Agent mode is always customer_reply; internal tasks
   *  use separate composers and never produce this record. */
  scope: 'customer_reply';
  resolvedTemplateId?: string;
  resolvedTemplateVersion?: number;
  includedBlocks: string[];
  excludedBlocks: ExcludedBlock[];
  allowedTools: string[];
}

/**
 * Merge the composer's block ledger with agent.service's module knowledge into
 * the persisted PromptTrace. The composer never emits MODULE_<id> (it sees module
 * sections only as opaque strings); agent.service owns them: active modules →
 * included, expected-but-inactive modules → excluded('module'). A module that is
 * both expected and active is included, never double-recorded.
 */
export function buildPromptTrace(
  ledger: BlockLedger,
  opts: {
    activeModuleIds: string[];
    expectedModuleIds?: string[];
    resolvedTemplateId?: string | null;
    resolvedTemplateVersion?: number | null;
  },
): PromptTrace {
  const active = new Set(opts.activeModuleIds);
  const includedModules = opts.activeModuleIds.map((id) => `MODULE_${id}`);
  const excludedModules: ExcludedBlock[] = (opts.expectedModuleIds ?? [])
    .filter((id) => !active.has(id))
    .map((id) => ({ key: `MODULE_${id}`, reason: 'module' as const }));

  return {
    scope: 'customer_reply',
    ...(opts.resolvedTemplateId ? { resolvedTemplateId: opts.resolvedTemplateId } : {}),
    ...(opts.resolvedTemplateVersion != null
      ? { resolvedTemplateVersion: opts.resolvedTemplateVersion }
      : {}),
    includedBlocks: [...ledger.getIncluded(), ...includedModules],
    excludedBlocks: [...ledger.getExcluded(), ...excludedModules],
    allowedTools: ledger.getAllowedTools(),
  };
}

/** Create a ledger seeded with the resolved tool names (recorded as allowedTools). */
export function createBlockLedger(allowedTools: string[] = []): BlockLedger {
  const included: string[] = [];
  const excluded: ExcludedBlock[] = [];
  const tools = [...allowedTools];
  return {
    include(key) {
      included.push(key);
    },
    exclude(key, reason) {
      excluded.push({ key, reason });
    },
    getIncluded() {
      return [...included];
    },
    getExcluded() {
      return excluded.map((e) => ({ ...e }));
    },
    getAllowedTools() {
      return [...tools];
    },
  };
}
