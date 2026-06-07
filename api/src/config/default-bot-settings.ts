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
import { BotSettings } from '../database/entities/Bot';
import { DEFAULT_SKILLS } from './default-skills';

/** Default behavioural `ai` block for a bot. `name` seeds the brand-voice name. */
export function defaultBotAi(name: string): NonNullable<BotSettings['ai']> {
  return {
    enabled: true,
    provider: 'openai',
    model: 'gpt-4o-mini',
    brandVoice: { name: `${name} Assistant`, tone: 'friendly', customInstructions: '', templateId: null },
    guardrails: {
      topicsToAvoid: [],
      escalationKeywords: ['speak to someone', 'human agent', 'talk to a person'],
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
