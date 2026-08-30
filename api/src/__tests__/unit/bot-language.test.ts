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
  SLOT_CHIP_CONFIRM_PREFIX,
  slotChipQuickReply,
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

describe('slot chips follow the bot language', () => {
  const start = '2026-04-07T07:00:00.000Z'; // 09:00 Europe/Amsterdam (CEST)
  const tz = 'Europe/Amsterdam';

  it('keeps the English title and Book-on-at sentence', () => {
    expect(slotChipQuickReply(start, tz, 'en')).toEqual({
      title: 'Tue 09:00',
      value: 'Book Tuesday 7 April at 09:00',
    });
    expect(slotChipQuickReply(start, tz, 'en', 'Lekdetectie')).toEqual({
      title: 'Tue 09:00',
      value: 'Book Lekdetectie on Tuesday 7 April at 09:00',
    });
  });

  it('names the weekday in Dutch and says Boek/op/om', () => {
    expect(slotChipQuickReply(start, tz, 'nl', 'Lekdetectie')).toEqual({
      title: 'di 09:00',
      value: 'Boek Lekdetectie op dinsdag 7 april om 09:00',
    });
  });

  it('names the weekday in French and says Réservez/le/à', () => {
    expect(slotChipQuickReply(start, tz, 'fr')).toEqual({
      title: 'mar. 09:00',
      value: 'Réservez le mardi 7 avril à 09:00',
    });
  });

  it('starts every issued chip with the confirm prefix', () => {
    for (const lang of BOT_LANGUAGES) {
      const chip = slotChipQuickReply(start, tz, lang, 'Lekdetectie');
      expect(SLOT_CHIP_CONFIRM_PREFIX.test(chip.title), `${lang} title ${chip.title}`).toBe(true);
      expect(SLOT_CHIP_CONFIRM_PREFIX.test(chip.value), `${lang} value ${chip.value}`).toBe(true);
    }
  });

  it('keeps a 12-hour title and Book-at-AM sentence', () => {
    expect(slotChipQuickReply('2026-04-07T13:00:00.000Z', 'America/New_York', 'en', 'Haircut')).toEqual({
      title: 'Tue 9:00 AM',
      value: 'Book Haircut on Tuesday 7 April at 9:00 AM',
    });
  });

  it('names mer. for a French Wednesday', () => {
    expect(slotChipQuickReply('2026-04-08T07:00:00.000Z', tz, 'fr').title).toBe('mer. 09:00');
  });

  it('prefixes every weekday in every bot language, under the confirm char cap', () => {
    const week = [
      '2026-04-06T07:00:00.000Z',
      '2026-04-07T07:00:00.000Z',
      '2026-04-08T07:00:00.000Z',
      '2026-04-09T07:00:00.000Z',
      '2026-04-10T07:00:00.000Z',
      '2026-04-11T07:00:00.000Z',
      '2026-04-12T07:00:00.000Z',
    ];
    for (const iso of week) {
      for (const lang of BOT_LANGUAGES) {
        const chip = slotChipQuickReply(iso, tz, lang, 'Lekdetectie');
        expect(chip.title.length).toBeLessThanOrEqual(80);
        expect(chip.value.length).toBeLessThanOrEqual(80);
        expect(SLOT_CHIP_CONFIRM_PREFIX.test(chip.title), `${lang} ${iso} ${chip.title}`).toBe(true);
        expect(SLOT_CHIP_CONFIRM_PREFIX.test(chip.value), `${lang} ${iso} ${chip.value}`).toBe(true);
      }
    }
  });
});
