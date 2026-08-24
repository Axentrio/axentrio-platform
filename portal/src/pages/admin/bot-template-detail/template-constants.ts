/**
 * Static option lists, label maps and preview lookups for the super-admin Bot
 * Template editor. Leaf module: it never imports AdminBotTemplateDetail.tsx.
 */
import type { SkillState, SkillRemedy } from '@contracts/skill-readiness';
import type { TemplateTier } from '../../../queries/useBotTemplatesQueries';

/** Tier options for the Identity control (mirrors the list page's ladder). */
export const TIER_OPTIONS: { id: TemplateTier; label: string }[] = [
  { id: 'essential', label: 'Essential' },
  { id: 'pro', label: 'Pro' },
  { id: 'enterprise', label: 'Enterprise' },
];

// Platform defaults — seeded as REAL values in the editor (not grey placeholders)
// so an author always sees the effective template, per the UX review.
export const DEFAULT_CONFIDENCE = '0.7';
export const DEFAULT_MAX_LENGTH = '500';

// Max-response-length presets (chars) with rough word estimates shown in the UI.
export const LENGTH_PRESETS = [
  { value: '300', words: '~45–60 words' },
  { value: '500', words: '~75–100 words' },
  { value: '900', words: '~130–170 words' },
  { value: '1200', words: '~180–230 words' },
] as const;
// One-click safety bundle for "topics to avoid".
export const COMMON_TOPICS = ['politics', 'religion', 'adult content', 'illegal activity', 'hate or harassment', 'self-harm', 'legal advice', 'medical diagnosis', 'financial advice'];

// Preview pane — the author previews mostly by PLAN (which gates capabilities);
// channel is a secondary toggle (it only tweaks reply length + proactive contact).
// Modules are NOT a knob: the preview assumes the template's Expected modules are
// enabled, so it reflects what THIS form declares.
export const TIER_LABELS: Record<string, string> = { free: 'Free', essential: 'Essential', pro: 'Pro', enterprise: 'Enterprise' };
export const CHANNEL_LABELS: Record<string, string> = { widget: 'Website widget', whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger', telegram: 'Telegram' };

// Outcome-language capabilities, keyed off the tools the bot would actually have.
// Absent → shown as a warning with a plain reason (no engineer jargon).
export const PREVIEW_CAPABILITIES: { tool: string; label: string; whenAbsent?: string }[] = [
  { tool: 'kb_search', label: 'Answer questions from its knowledge base' },
  { tool: 'capture_lead', label: 'Capture leads and take contact details', whenAbsent: 'available on paid plans' },
  { tool: 'create_booking', label: 'Book appointments', whenAbsent: 'needs the Bookings module on' },
  { tool: 'escalate_to_human', label: 'Hand off to a person' },
];

// Plain-English gloss for the composer's exclusion reason codes (technical view).
export const REASON_TEXT: Record<string, string> = {
  empty: 'not set',
  channel: 'not used on this channel',
  toolAbsent: 'needs a capability that isn’t on',
  tier: 'available on higher plans',
  module: 'needs the matching module on',
  specialty: 'specialty not selected on the bot',
  bookingConfigured: 'booking isn’t set up yet',
};

// Composable-templates (Phase 5): the engineered skills a module can bind, with
// the preview tools each exposes. v1 = booking only; used to (a) feed the bound
// skills into the scenario preview and (b) derive a per-skill state badge from the
// ledger. ponytail: booking-only by design — extend this map as skills land.
export const SKILL_PREVIEW: Record<string, { tools: string[]; label: string }> = {
  booking: { tools: ['create_booking', 'check_availability', 'request_appointment'], label: 'Bookings' },
};
export const stateToRemedy = (s: SkillState): SkillRemedy =>
  s === 'unentitled' ? 'upgrade' : s === 'disabled' ? 'turn on' : s === 'unconfigured' ? 'finish setup' : null;

// Blocks the author can't touch from a template — they need a bound bot, a live
// conversation, or tenant-level config, so they can NEVER appear in a template
// preview. Hidden entirely (they're not gaps, and not actionable here).
export const PREVIEW_HIDDEN_BLOCKS: Record<string, true> = {
  EXTRA_INFO: true, CUSTOMER_NAME: true, AVAILABLE_SKILLS: true, KB_CONTEXT: true,
};

// Actionable note for an excluded block the author CAN fix from the template here.
export const EXCLUDED_NOTE: Record<string, string> = {
  BOOKING: 'add Bookings to Expected modules',
};

// Plain-English "what is this block" for the preview tooltips.
export const BLOCK_INFO: Record<string, string> = {
  TEMPLATE_BODY: 'The prompt body you write above (or a generic service fallback if it’s blank).',
  KNOWLEDGE: 'Tells the bot to search its knowledge base before answering factual questions.',
  KB_CONTEXT: 'Knowledge-base snippets retrieved for the customer’s current question.',
  CONTACT_DETAILS: 'Lets the bot take the customer’s contact details (lead capture).',
  CHANNEL_LEAD_CAPTURE: 'On messaging channels, the bot proactively confirms the customer’s contact details.',
  SOCIAL_SHORT_REPLY: 'On messaging channels, keeps replies short and chat-style.',
  CUSTOMER_NAME: 'The customer’s name, taken from their messaging profile.',
  EXTRA_INFO: 'Extra background the tenant adds on the bot (reference only).',
  AVAILABLE_SKILLS: 'The skills the bound bot has enabled.',
  ESCALATION: 'Lets the bot hand the conversation off to a human.',
  BOOKING: 'Booking behaviour and tools — check availability and create a booking.',
};
export function getBlockInfo(key: string): string {
  if (BLOCK_INFO[key]) return BLOCK_INFO[key];
  if (key.startsWith('MODULE_')) return `Instructions added by the ${key.slice(7)} module.`;
  if (key.startsWith('SPECIALTY_')) return `Tailored handling for the ${key.slice(10).replace(/_/g, ' ')} specialty.`;
  return 'A prompt block contributed at runtime.';
}
