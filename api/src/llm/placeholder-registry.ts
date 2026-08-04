/**
 * Resolves the {placeholder} catalog to concrete values for one prompt render.
 *
 * The catalog (contracts/prompt-placeholders.ts) is the single source of truth for
 * WHICH keys exist; this module is the single source of truth for WHAT each one
 * resolves to. `RESOLVERS` is an exhaustive `Record<PlaceholderKey, …>`, so tsc
 * fails if a catalogued key has no resolver (or a resolver has no catalog entry) —
 * the composer/linter/editor can never drift apart again.
 *
 * NO DATABASE ACCESS. `PlaceholderContext` deliberately carries no repository or
 * manager handle, so a resolver physically cannot issue a query per turn. Any
 * DB-backed value must be resolved UPSTREAM into `extras` (see how agent.service
 * builds `services`/`openingHours` from rows the booking block already loads).
 *
 * SECURITY: every value here is substituted verbatim into the LLM system prompt.
 * Never resolve a secret. See placeholder-registry.test.ts for the runtime guard.
 */
import type { Tenant } from '../database/entities/Tenant';
import { PLACEHOLDER_CATALOG, type PlaceholderKey } from '../contracts/prompt-placeholders';

type AiSettings = NonNullable<NonNullable<Tenant['settings']>['ai']>;

/** Values injected into the placeholder map beyond the bot's own `ai` slice. */
export type PromptExtras = {
  businessName?: string;
  /** Live booking config for {services} / {openingHours}. The composer passes these
   *  ONLY when the bot can actually book — a gated bot must never advertise
   *  services it cannot book (see assembleAgent). */
  services?: string;
  openingHours?: string;
  /** Rendered service area for {serviceArea}; '' when the bot has none. */
  serviceArea?: string;
};

export type PlaceholderContext = { ai: AiSettings; extras?: PromptExtras };

/** Exhaustive by construction — a missing/extra key is a compile error. */
export const RESOLVERS: Record<PlaceholderKey, (c: PlaceholderContext) => string> = {
  botName: ({ ai }) => ai.brandVoice?.name || 'AI Assistant',
  tone: ({ ai }) => ai.brandVoice?.tone || 'friendly',
  supportEmail: ({ ai }) => ai.supportEmail || '',
  // Per-bot override wins; otherwise the tenant business name passed by the
  // caller (tenant.name / org name) is the inherited default.
  businessName: ({ ai, extras }) => ai.brandVoice?.businessName || extras?.businessName || '',
  fallbackMessage: ({ ai }) => ai.guardrails?.fallbackMessage || '',
  offHoursMessage: ({ ai }) => ai.guardrails?.offHoursMessage || '',
  greetingMessage: ({ ai }) => ai.guardrails?.greetingMessage || '',
  maxResponseLength: ({ ai }) => String(ai.guardrails?.maxResponseLength ?? 500),
  topicsToAvoid: ({ ai }) => (ai.guardrails?.topicsToAvoid ?? []).join(', ') || 'N/A',
  services: ({ extras }) => extras?.services || '',
  openingHours: ({ extras }) => extras?.openingHours || '',
  serviceArea: ({ extras }) => extras?.serviceArea || '',
};

/**
 * NOTE: keys in the returned vars map are echoed into the LLM system prompt —
 * never include secrets (API keys, tokens, webhooks).
 *
 * Custom template variables the tenant filled in (per bot) are spread FIRST so the
 * reserved built-in keys always win — a tenant can never redefine {businessName}
 * etc. via a custom var. Every catalogued key is always present (fail-closed), so a
 * declared placeholder can never leak into the prompt as a literal `{key}`.
 *
 * `extraInfo` is deliberately NOT a placeholder. It is rendered ONLY as a fenced
 * lowest-authority block in assembleAgent (§11b) — exposing it as a {extra_info}
 * substitution would let a template/custom layer inject the raw tenant text
 * UNFENCED into a higher-authority position (codex review).
 */
export function buildVariableMap(ai: AiSettings, extras?: PromptExtras): Record<string, string> {
  const custom = (ai as { templateVariables?: Record<string, string> }).templateVariables ?? {};
  const out: Record<string, string> = { ...custom };
  const ctx: PlaceholderContext = { ai, extras };
  for (const entry of PLACEHOLDER_CATALOG) {
    out[entry.key] = RESOLVERS[entry.key](ctx) ?? entry.failClosed;
  }
  return out;
}
