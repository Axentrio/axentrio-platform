/**
 * Default language for a bot's first greeting (and greeting chips).
 * Later replies still follow the visitor. jsonb on settings.ai — no migration.
 */
export const BOT_LANGUAGES = ['en', 'nl', 'fr'] as const;
export type BotLanguage = (typeof BOT_LANGUAGES)[number];

export const DEFAULT_GREETING_BY_LANGUAGE: Record<BotLanguage, string> = {
  en: 'Welcome! How can I help you today?',
  nl: 'Welkom! Waarmee kan ik je helpen?',
  fr: 'Bienvenue ! Comment puis-je vous aider ?',
};

/** Last chip is the handoff phrase. Must stay in DEFAULT_ESCALATION_KEYWORDS. */
export const GREETING_QUICK_REPLIES_BY_LANGUAGE: Record<BotLanguage, readonly string[]> = {
  en: ['Book appointment', 'Our services', 'Pricing', 'Talk to someone'],
  nl: ['Afspraak maken', 'Onze diensten', 'Prijzen', 'Praat met iemand'],
  fr: ['Prendre rendez-vous', 'Nos services', 'Tarifs', "Parler à quelqu'un"],
};

export function isBotLanguage(value: unknown): value is BotLanguage {
  return value === 'en' || value === 'nl' || value === 'fr';
}

export function resolveBotLanguage(stored?: string | null): BotLanguage {
  return isBotLanguage(stored) ? stored : 'en';
}

/** Stock greeting follows language. A custom greeting stays as written. */
export function resolveGreetingMessage(stored: string | undefined, language: BotLanguage): string {
  const text = stored?.trim() ?? '';
  if (!text) return DEFAULT_GREETING_BY_LANGUAGE[language];
  const stock = Object.values(DEFAULT_GREETING_BY_LANGUAGE);
  if (stock.includes(text)) return DEFAULT_GREETING_BY_LANGUAGE[language];
  return text;
}

export function greetingQuickReplies(language: BotLanguage): readonly string[] {
  return GREETING_QUICK_REPLIES_BY_LANGUAGE[language];
}
