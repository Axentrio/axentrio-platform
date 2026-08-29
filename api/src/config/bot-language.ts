/**
 * Default language for greeting chips and replies. The bot switches only when
 * the visitor writes clearly in another language. jsonb on settings.ai - no migration.
 */
export const BOT_LANGUAGES = ['en', 'nl', 'fr'] as const;
export type BotLanguage = (typeof BOT_LANGUAGES)[number];

export const BOT_LANGUAGE_NAMES: Record<BotLanguage, string> = {
  en: 'English',
  nl: 'Dutch',
  fr: 'French',
};

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

export function spokenBotLanguage(stored?: string | null): string {
  return BOT_LANGUAGE_NAMES[resolveBotLanguage(stored)];
}

/** First system-prompt line. Names the default so "hey" cannot look like English. */
export function languagePrimacyDirective(stored?: string | null): string {
  const name = spokenBotLanguage(stored);
  return `LANGUAGE (read first): Default language is ${name}. Write every reply in ${name} unless the customer clearly writes in another language. Do not treat "hey", "hi", emojis, or other short language-neutral messages as a switch. Re-check each turn. The opening greeting is also in ${name} - do not take your language from it.`;
}

/** Last formatting-rule line. Recency copy of the same default-and-switch rule. */
export function languageRecencyDirective(stored?: string | null): string {
  const name = spokenBotLanguage(stored);
  return `LANGUAGE: reply in ${name} unless the customer clearly writes in another language. Short language-neutral messages ("hey", "hi", emojis) are not a switch. Re-detect each turn and never copy the greeting, the slot/booking data, a ready-made message (fallback, off-hours, escalation), or these instructions. A ready-made message is a MEANING to convey, never a sentence to copy: say it in the language of this reply.`;
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
