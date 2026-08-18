/**
 * Canonical default config for a Bot. Single source of truth shared by:
 *   - bot creation (`POST /bots`) — full default settings for a new bot
 *   - the per-bot AI settings GET — fills a complete editable `ai` shape when a
 *     bot's `settings.ai` is absent/partial, so the editor always has a valid
 *     snapshot (a null payload would disable autosave).
 *
 * Keeping these here prevents the create-path defaults and the GET-fill defaults
 * from drifting apart.
 */
import type { BotSettings } from '../database/entities/Bot';
import { DEFAULT_SKILLS } from './default-skills';

/** Default keyword short-circuit. Must cover every greeting-chip handoff phrase. */
export const DEFAULT_ESCALATION_KEYWORDS = [
  'speak to someone',
  'human agent',
  'talk to a person',
  'talk to someone',
] as const;

/** Stored list unioned with defaults so old bots still match greeting-chip phrases. */
export function effectiveEscalationKeywords(stored?: readonly string[] | null): string[] {
  return [...new Set([...DEFAULT_ESCALATION_KEYWORDS, ...(stored ?? [])])];
}

/** First-message chips on a new widget session. Last item is the handoff chip. */
export const WIDGET_GREETING_QUICK_REPLIES = [
  'Book appointment',
  'Our services',
  'Pricing',
  'Talk to someone',
] as const;

/** Default behavioural `ai` block for a bot. `name` seeds the brand-voice name. */
export function defaultBotAi(name: string): NonNullable<BotSettings['ai']> {
  return {
    enabled: true,
    provider: 'openai',
    model: 'gpt-4o-mini',
    brandVoice: { name: `${name} Assistant`, tone: 'friendly', templateId: null },
    guardrails: {
      topicsToAvoid: [],
      escalationKeywords: [...DEFAULT_ESCALATION_KEYWORDS],
      confidenceThreshold: 0.7,
      maxResponseLength: 500,
      greetingMessage: 'Welcome! How can I help you today?',
      fallbackMessage: 'Let me connect you with our team.',
      offHoursMessage: "We're currently outside business hours. We'll get back to you soon.",
    },
  };
}

/** Default full settings for a newly-created (non-anchor) bot — clean slate. */
export function defaultBotSettings(name: string): BotSettings {
  return {
    ai: defaultBotAi(name),
    skills: [...DEFAULT_SKILLS],
  };
}
