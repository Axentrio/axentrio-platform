import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GREETING_BY_LANGUAGE,
  GREETING_QUICK_REPLIES_BY_LANGUAGE,
  greetingQuickReplies,
  resolveBotLanguage,
  resolveGreetingMessage,
} from '../../config/bot-language';
import { DEFAULT_ESCALATION_KEYWORDS, defaultBotAi } from '../../config/default-bot-settings';

function coveredByKeyword(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

describe('bot default language', () => {
  it('falls back to English when the stored value is missing or unknown', () => {
    expect(resolveBotLanguage(undefined)).toBe('en');
    expect(resolveBotLanguage(null)).toBe('en');
    expect(resolveBotLanguage('de')).toBe('en');
  });

  it('keeps a known language', () => {
    expect(resolveBotLanguage('nl')).toBe('nl');
    expect(resolveBotLanguage('fr')).toBe('fr');
  });

  it('swaps a stock greeting when the language changes', () => {
    expect(resolveGreetingMessage(DEFAULT_GREETING_BY_LANGUAGE.en, 'nl')).toBe(
      DEFAULT_GREETING_BY_LANGUAGE.nl,
    );
    expect(resolveGreetingMessage(DEFAULT_GREETING_BY_LANGUAGE.nl, 'fr')).toBe(
      DEFAULT_GREETING_BY_LANGUAGE.fr,
    );
  });

  it('keeps a custom greeting', () => {
    expect(resolveGreetingMessage('Hey hey! Wat speelt er?', 'nl')).toBe('Hey hey! Wat speelt er?');
  });

  it('uses the stock greeting when the stored text is blank', () => {
    expect(resolveGreetingMessage('  ', 'fr')).toBe(DEFAULT_GREETING_BY_LANGUAGE.fr);
  });

  it('covers every language handoff chip with the default keywords', () => {
    const keywords = defaultBotAi('x').guardrails.escalationKeywords;
    expect(keywords).toEqual([...DEFAULT_ESCALATION_KEYWORDS]);
    for (const lang of ['en', 'nl', 'fr'] as const) {
      const chips = greetingQuickReplies(lang);
      expect(chips).toEqual(GREETING_QUICK_REPLIES_BY_LANGUAGE[lang]);
      const handoff = chips[chips.length - 1];
      expect(coveredByKeyword(handoff, keywords), handoff).toBe(true);
    }
  });
});
