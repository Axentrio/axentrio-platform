// Builds the LLM system prompt from a tenant's AI settings.
//
// If `brandVoice.customInstructions` is set, it is treated as the FULL base
// system prompt (with placeholder substitution). Otherwise falls back to the
// legacy auto-constructed prompt.

import type { Tenant } from '../database/entities/Tenant';

type AiSettings = NonNullable<Tenant['settings']>['ai'];

const PLACEHOLDER_RE = /\{(\w+)\}/g;

// NOTE: keys in the returned `vars` map are echoed into the LLM system prompt —
// never include secrets (API keys, tokens, webhooks).
function buildVariableMap(
  ai: NonNullable<AiSettings>,
  extras?: { businessName?: string }
): Record<string, string> {
  const g = ai.guardrails;
  return {
    botName: ai.brandVoice?.name || 'AI Assistant',
    tone: ai.brandVoice?.tone || 'friendly',
    supportEmail: ai.supportEmail || '',
    businessName: extras?.businessName || '',
    fallbackMessage: g?.fallbackMessage || '',
    offHoursMessage: g?.offHoursMessage || '',
    greetingMessage: g?.greetingMessage || '',
    maxResponseLength: String(g?.maxResponseLength ?? 500),
    topicsToAvoid: (g?.topicsToAvoid ?? []).join(', ') || 'N/A',
  };
}

// Substitutes {placeholders} in an arbitrary string using the tenant's ai vars.
// Unknown keys are preserved as `{key}` rather than stripped.
export function substituteVariables(
  template: string,
  ai: NonNullable<AiSettings>,
  extras?: { businessName?: string }
): string {
  if (!template) return '';
  const vars = buildVariableMap(ai, extras);
  return template.replace(PLACEHOLDER_RE, (_, key) => vars[key] ?? `{${key}}`);
}

export function buildSystemPrompt(
  ai: NonNullable<AiSettings>,
  extras?: { businessName?: string }
): string {
  const customInstructions = ai.brandVoice?.customInstructions?.trim() ?? '';

  if (customInstructions) {
    return substituteVariables(customInstructions, ai, extras);
  }

  // Legacy fallback — kept for tenants who haven't set a base prompt yet.
  return substituteVariables(
    `You are {botName}.
Tone: {tone}

Rules:
- Never discuss: {topicsToAvoid}
- Max response: {maxResponseLength} characters
- If you cannot help, say: "{fallbackMessage}"`,
    ai,
    extras
  );
}
