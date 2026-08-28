import { describe, it, expect } from 'vitest';
import { costUsd } from '../../llm/pricing';

describe('costUsd', () => {
  it('prices one million tokens of gpt-5.6-luna at 1.40 USD', () => {
    expect(
      costUsd('gpt-5.6-luna', { promptTokens: 1_000_000, completionTokens: 1_000_000 }),
    ).toBe(1.4);
  });

  it('prices one million embedding tokens at 0.13 USD', () => {
    expect(
      costUsd('text-embedding-3-large', { promptTokens: 1_000_000, completionTokens: 0 }),
    ).toBe(0.13);
  });

  it('returns 0 for an unknown model and does not throw', () => {
    expect(costUsd('not-a-real-model', { promptTokens: 100, completionTokens: 50 })).toBe(0);
  });
});
