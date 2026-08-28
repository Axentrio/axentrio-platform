import { describe, expect, it } from 'vitest';
import { renderSystemPrompt } from '../../copilot/agent/prompt';

const args = {
  history: [],
  snippets: [],
  tools: [],
  newUserText: 'welke dieren zijn in afrika?',
  requestedLocale: 'nl' as const,
};

describe('renderSystemPrompt', () => {
  it('tells Copilot to refuse off-topic general knowledge', () => {
    const prompt = renderSystemPrompt(args);

    expect(prompt).toMatch(/do not answer general-knowledge or off-topic/i);
    expect(prompt).toMatch(/even if you know the answer/i);
  });
});
