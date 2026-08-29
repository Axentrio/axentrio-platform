import { describe, it, expect } from 'vitest';
import {
  BOT_LANGUAGES,
  BOT_LANGUAGE_NAMES,
  DEFAULT_GREETING_BY_LANGUAGE,
  GREETING_QUICK_REPLIES_BY_LANGUAGE,
  greetingQuickReplies,
  languagePrimacyDirective,
  languageRecencyDirective,
  resolveBotLanguage,
  resolveGreetingMessage,
  spokenBotLanguage,
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

  it('names Dutch so an ambiguous hey stays on the default', () => {
    expect(spokenBotLanguage('nl')).toBe('Dutch');
    expect(languagePrimacyDirective('nl')).toContain('Default language is Dutch');
    expect(languagePrimacyDirective('nl')).toContain('"hey"');
    expect(languageRecencyDirective('nl')).toContain('reply in Dutch');
    expect(languageRecencyDirective('nl')).toContain('"hey"');
  });

  it('names English when the stored language is missing', () => {
    expect(spokenBotLanguage(undefined)).toBe('English');
    expect(languagePrimacyDirective(undefined)).toContain('Default language is English');
  });

  it('inserts the spoken name in both directives with no placeholder', () => {
    for (const lang of BOT_LANGUAGES) {
      const name = BOT_LANGUAGE_NAMES[lang];
      const primacy = languagePrimacyDirective(lang);
      const recency = languageRecencyDirective(lang);
      expect(primacy).toContain(`Default language is ${name}`);
      expect(recency).toContain(`reply in ${name}`);
      expect(primacy).not.toMatch(/\{/);
      expect(recency).not.toMatch(/\{/);
    }
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
