import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ESCALATION_KEYWORDS,
  WIDGET_GREETING_QUICK_REPLIES,
  defaultBotAi,
  effectiveEscalationKeywords,
} from '../../config/default-bot-settings';

function coveredByKeyword(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

describe('greeting chip \u2194 default escalation keywords', () => {
  it('every greeting handoff chip is a default-keyword match', () => {
    const keywords = defaultBotAi('x').guardrails.escalationKeywords;
    expect(keywords).toEqual([...DEFAULT_ESCALATION_KEYWORDS]);

    const handoffChips = WIDGET_GREETING_QUICK_REPLIES.filter((chip) =>
      /talk|speak|human|agent|persoon|parler|iemand/i.test(chip),
    );
    expect(handoffChips.length).toBeGreaterThan(0);
    for (const chip of handoffChips) {
      expect(coveredByKeyword(chip, keywords), chip).toBe(true);
    }
  });

  it('unions defaults so an old-3-keyword bot matches the greeting chip',
    () => {
      const oldStored = ['speak to someone', 'human agent', 'talk to a person'];
      const keywords = effectiveEscalationKeywords(oldStored);
      expect(keywords).toHaveLength(6);
      expect(coveredByKeyword('Talk to someone', oldStored)).toBe(false);
      expect(coveredByKeyword('Talk to someone', keywords)).toBe(true);
    },
  );

  it('still matches a custom stored keyword', () => {
    const keywords = effectiveEscalationKeywords(['refund']);
    expect(coveredByKeyword('I want a refund', keywords)).toBe(true);
  });
});
