import { describe, it, expect, beforeEach, vi } from 'vitest';

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));

vi.mock('../../llm/provider-factory', () => ({
  getProvider: () => ({ chat: chatMock }),
}));
vi.mock('../../llm/defaults', () => ({ DEFAULT_PROVIDER: 'openai', DEFAULT_MODEL: 'gpt-4o-mini' }));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { judgeTranscript } from '../../insights/judge.service';

const TX = [
  { id: 'm1', sender: 'user' as const, content: 'do you offer warranty?' },
  { id: 'm2', sender: 'bot' as const, content: 'I am not sure.' },
];

function reply(obj: Record<string, unknown>) {
  chatMock.mockResolvedValue({
    content: JSON.stringify(obj),
    usage: { promptTokens: 10, completionTokens: 5 },
  });
}

beforeEach(() => chatMock.mockReset());

describe('judge · sentiment tiers', () => {
  it('without withSentiment: prompt is the base contract and no sentiment is parsed', async () => {
    reply({ hadQuestion: true, satisfied: false, topic: 'warranty', evidenceMessageIds: ['m1'], reasoning: 'asked, not answered', sentiment: 'negative', sentimentTheme: 'slow' });
    const v = await judgeTranscript('t1', TX, false);

    const systemPrompt = chatMock.mock.calls[0][0][0].content;
    expect(systemPrompt).not.toMatch(/sentiment/i); // base prompt, byte-identical
    expect(v.sentiment).toBeNull(); // ignored even if the model volunteered it
    expect(v.sentimentTheme).toBeNull();
    expect(v.topicPhrase).toBe('warranty');
    expect(chatMock.mock.calls[0][1].reasoningEffort).toBe('low');
  });

  it('with basic sentiment: parses sentiment but never requests or accepts a theme', async () => {
    reply({ hadQuestion: true, satisfied: false, topic: 'warranty', evidenceMessageIds: ['m1'], reasoning: 'x', sentiment: 'negative', sentimentTheme: 'unclear answers' });
    const v = await judgeTranscript('t1', TX, false, undefined, { withSentiment: true });

    const systemPrompt = chatMock.mock.calls[0][0][0].content;
    expect(systemPrompt).toMatch(/"sentiment"/);
    expect(systemPrompt).not.toMatch(/sentimentTheme/);
    expect(v.sentiment).toBe('negative');
    expect(v.sentimentTheme).toBeNull();
  });

  it('with sentiment themes: parses both fields for Enterprise', async () => {
    reply({ hadQuestion: true, satisfied: false, topic: 'warranty', evidenceMessageIds: ['m1'], reasoning: 'x', sentiment: 'negative', sentimentTheme: 'unclear answers' });
    const v = await judgeTranscript('t1', TX, false, undefined, {
      withSentiment: true,
      withSentimentThemes: true,
    });

    const systemPrompt = chatMock.mock.calls[0][0][0].content;
    expect(systemPrompt).toMatch(/sentimentTheme/);
    expect(v.sentiment).toBe('negative');
    expect(v.sentimentTheme).toBe('unclear answers');
  });

  it('with withSentiment but a bad sentiment value: nulls it (guarded)', async () => {
    reply({ hadQuestion: false, satisfied: null, topic: null, evidenceMessageIds: [], reasoning: 'small talk', sentiment: 'ecstatic', sentimentTheme: '   ' });
    const v = await judgeTranscript('t1', TX, false, undefined, { withSentiment: true });
    expect(v.sentiment).toBeNull();
    expect(v.sentimentTheme).toBeNull();
  });
});
