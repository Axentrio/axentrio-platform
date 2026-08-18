import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  gaps: [] as Array<Record<string, unknown>>,
  judgments: [] as Array<Record<string, unknown>>,
  saved: [] as Array<Record<string, unknown>>,
}));
const chatMock = vi.hoisted(() => vi.fn());

vi.mock('../../llm/provider-factory', () => ({
  getProvider: () => ({ chat: chatMock }),
}));
vi.mock('../../llm/defaults', () => ({
  DEFAULT_PROVIDER: 'openai',
  DEFAULT_MODEL: 'test-model',
}));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn() },
}));
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'Gap') {
        return {
          find: async () => state.gaps,
          save: async (gap: Record<string, unknown>) => {
            state.saved.push({ ...gap });
            return gap;
          },
        };
      }
      if (entity.name === 'CanonicalTopic') {
        return {
          findOne: async ({ where }: { where: { id: string } }) => ({
            topic: where.id === 'topic-pricing' ? 'pricing' : 'opening hours',
          }),
        };
      }
      if (entity.name === 'Judgment') {
        const qb: Record<string, unknown> = {};
        for (const method of ['where', 'andWhere', 'orderBy', 'limit']) {
          qb[method] = () => qb;
        }
        qb.getMany = async () => state.judgments;
        return { createQueryBuilder: () => qb };
      }
      throw new Error(`unexpected repo ${entity.name}`);
    },
  },
}));

import { generateGapRecommendations } from '../../insights/gap-recommendation.service';

const NOW = new Date('2026-08-18T12:00:00Z');

beforeEach(() => {
  state.gaps = [];
  state.judgments = [];
  state.saved = [];
  chatMock.mockReset();
  chatMock.mockResolvedValue({
    content: 'Add clear pricing to your knowledge base.',
    usage: { promptTokens: 12, completionTokens: 7 },
  });
});

describe('generateGapRecommendations', () => {
  it('generates from evidence for open Gaps and clears closed Gap suggestions', async () => {
    state.gaps = [
      {
        id: 'open',
        tenantId: 'tenant-1',
        canonicalTopicId: 'topic-pricing',
        status: 'open',
        occurrences: 5,
        recommendation: null,
      },
      {
        id: 'resolved',
        tenantId: 'tenant-1',
        canonicalTopicId: 'topic-hours',
        status: 'resolved_data',
        occurrences: 3,
        recommendation: 'Stale suggestion',
        recommendationUpdatedAt: new Date('2026-08-01T12:00:00Z'),
      },
    ];
    state.judgments = [{ reasoning: 'The Agent could not answer what the service costs.' }];
    const tally = { promptTokens: 0, completionTokens: 0, calls: 0 };

    await generateGapRecommendations('tenant-1', tally, NOW);

    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(chatMock.mock.calls[0][0][1].content).toContain('could not answer what the service costs');
    expect(state.gaps[0].recommendation).toBe('Add clear pricing to your knowledge base.');
    expect(state.gaps[0].recommendationUpdatedAt).toBe(NOW);
    expect(state.gaps[1].recommendation).toBeNull();
    expect(state.gaps[1].recommendationUpdatedAt).toBeNull();
    expect(tally).toEqual({ promptTokens: 12, completionTokens: 7, calls: 1 });
  });

  it('does not regenerate a fresh recommendation', async () => {
    state.gaps = [{
      id: 'fresh',
      tenantId: 'tenant-1',
      canonicalTopicId: 'topic-pricing',
      status: 'open',
      occurrences: 5,
      recommendation: 'Keep pricing current.',
      recommendationUpdatedAt: new Date('2026-08-17T12:00:00Z'),
    }];
    state.judgments = [{ reasoning: 'Pricing was unanswered.' }];

    await generateGapRecommendations('tenant-1', undefined, NOW);

    expect(chatMock).not.toHaveBeenCalled();
    expect(state.saved).toHaveLength(0);
  });

  it('skips a Gap without evidence', async () => {
    state.gaps = [{
      id: 'empty',
      tenantId: 'tenant-1',
      canonicalTopicId: 'topic-pricing',
      status: 'open',
      occurrences: 5,
      recommendation: null,
    }];
    state.judgments = [{ reasoning: '   ' }];

    await generateGapRecommendations('tenant-1', undefined, NOW);

    expect(chatMock).not.toHaveBeenCalled();
    expect(state.saved).toHaveLength(0);
  });

  it('caps model calls at ten per run', async () => {
    state.gaps = Array.from({ length: 12 }, (_, index) => ({
      id: `gap-${index}`,
      tenantId: 'tenant-1',
      canonicalTopicId: 'topic-pricing',
      status: 'open',
      occurrences: 5,
      recommendation: null,
    }));
    state.judgments = [{ reasoning: 'Pricing was unanswered.' }];

    await generateGapRecommendations('tenant-1', undefined, NOW);

    expect(chatMock).toHaveBeenCalledTimes(10);
    expect(state.saved).toHaveLength(10);
  });

  it('keeps only one sentence and at most 160 characters', async () => {
    state.gaps = [{
      id: 'long',
      tenantId: 'tenant-1',
      canonicalTopicId: 'topic-pricing',
      status: 'open',
      occurrences: 5,
      recommendation: null,
    }];
    state.judgments = [{ reasoning: 'Pricing was unanswered.' }];
    chatMock.mockResolvedValue({
      content: `${'A'.repeat(170)}. Add a second action.`,
      usage: { promptTokens: 12, completionTokens: 7 },
    });

    await generateGapRecommendations('tenant-1', undefined, NOW);

    expect(state.gaps[0].recommendation).toHaveLength(160);
    expect(state.gaps[0].recommendation).not.toContain('second');
  });

  it('drops a second sentence', async () => {
    state.gaps = [{
      id: 'multiple',
      tenantId: 'tenant-1',
      canonicalTopicId: 'topic-pricing',
      status: 'open',
      occurrences: 5,
      recommendation: null,
    }];
    state.judgments = [{ reasoning: 'Pricing was unanswered.' }];
    chatMock.mockResolvedValue({
      content: 'Publish your prices. Add opening hours too.',
      usage: { promptTokens: 12, completionTokens: 7 },
    });

    await generateGapRecommendations('tenant-1', undefined, NOW);

    expect(state.gaps[0].recommendation).toBe('Publish your prices.');
  });

  it('fails open without replacing the last good suggestion', async () => {
    state.gaps = [{
      id: 'open',
      tenantId: 'tenant-1',
      canonicalTopicId: 'topic-pricing',
      status: 'open',
      occurrences: 5,
      recommendation: 'Keep the existing advice.',
    }];
    chatMock.mockRejectedValue(new Error('provider unavailable'));

    state.judgments = [{ reasoning: 'Pricing was unanswered.' }];

    await expect(generateGapRecommendations('tenant-1', undefined, NOW)).resolves.toBeUndefined();
    expect(state.gaps[0].recommendation).toBe('Keep the existing advice.');
  });
});
