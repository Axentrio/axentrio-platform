/**
 * Default language for greeting chips and replies. The bot switches only when
 * the visitor writes clearly in another language. jsonb on settings.ai - no migration.
 */
import { DateTime } from 'luxon';
import { luxonChipTitleFormat, luxonTimeFormat } from '../contracts/clock-format';

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

/** Verb that starts a tapped slot-chip sentence. isConfirmingChip reads the same list. */
export const SLOT_CHIP_VERBS: Record<BotLanguage, string> = {
  en: 'Book',
  nl: 'Boek',
  fr: 'Réservez',
};

/**
 * Weekday tokens Luxon `ccc` emits for en/nl/fr. French keeps a trailing
 * period (`mar.`), so the confirm prefix cannot rely on `\b` after the token.
 */
export const SLOT_CHIP_WEEKDAYS = [
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim',
  'ma', 'di', 'wo', 'do', 'vr', 'za', 'zo',
] as const;

function slotChipVerbAlternation(): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const verb of Object.values(SLOT_CHIP_VERBS)) {
    for (const form of [verb, verb.normalize('NFD').replace(/\p{M}/gu, '')]) {
      const key = form.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
  }
  return parts.join('|');
}

/**
 * Prefix of a chip we issued: Book/Boek/Réservez, or weekday+time (`Tue 09:00`,
 * `di 09:00`, `mar. 09:00`). A period is not a word character, so `mar.` would
 * fail `\b`; the weekday arm therefore allows an optional trailing dot and
 * then whitespace.
 */
export const SLOT_CHIP_CONFIRM_PREFIX = new RegExp(
  `^(?:(?:${slotChipVerbAlternation()})\\b|(?:${SLOT_CHIP_WEEKDAYS.join('|')})\\.?\\s)`,
  'i',
);

/**
 * A tapped slot chip is sent back as a customer sentence. It has to be in the
 * bot language: an English "Book … on Tuesday" under a Dutch reply is the same
 * class of leak as a canned fallback that never went through localizeMessage.
 */
export function slotChipQuickReply(
  startIso: string,
  timezone: string,
  language: BotLanguage,
  serviceName?: string | null,
): { title: string; value: string } {
  const dt = DateTime.fromISO(startIso).setZone(timezone).setLocale(language);
  const date = dt.toFormat('cccc d LLLL');
  const time = dt.toFormat(luxonTimeFormat(timezone));
  const service = serviceName?.trim() || '';
  return {
    title: dt.toFormat(luxonChipTitleFormat(timezone)),
    value: slotChipValue(language, { service, date, time }),
  };
}

function slotChipValue(
  language: BotLanguage,
  parts: { service: string; date: string; time: string },
): string {
  const { service, date, time } = parts;
  const verb = SLOT_CHIP_VERBS[language];
  if (language === 'nl') {
    return service ? `${verb} ${service} op ${date} om ${time}` : `${verb} ${date} om ${time}`;
  }
  if (language === 'fr') {
    return service ? `${verb} ${service} le ${date} à ${time}` : `${verb} le ${date} à ${time}`;
  }
  return service ? `${verb} ${service} on ${date} at ${time}` : `${verb} ${date} at ${time}`;
}
