import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../knowledge/embedding.service', () => ({
  embed: vi.fn(async () => [0.1, 0.2]),
}));

import { needsQueryRewrite, searchKnowledge } from '../../llm/rag.service';

describe('needsQueryRewrite', () => {
  const history = [{ role: 'user' as const, content: 'Do you install heat pumps?' }];

  it('skips when there is no history', () => {
    expect(needsQueryRewrite('what about the battery?', [])).toBe(false);
  });

  it('skips a long self-contained question', () => {
    expect(
      needsQueryRewrite(
        'What are your opening hours on Saturday morning in Antwerp centre please?',
        history,
      ),
    ).toBe(false);
  });

  it('rewrites a short follow-up', () => {
    expect(needsQueryRewrite('what about that one?', history)).toBe(true);
  });
});

describe('searchKnowledge retrieve', () => {
  const queries: string[] = [];
  const dataSource = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      return [];
    }),
  };

  beforeEach(() => {
    queries.length = 0;
    dataSource.query.mockClear();
  });

  it('runs a vector ORDER BY that HNSW can serve, plus a separate keyword query', async () => {
    await searchKnowledge(dataSource as never, 't1', 'opening hours', []);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/ORDER BY kc.embedding <=> \$1::vector/);
    // `1 - $3` infers integer and rejects RAG_MIN_SIMILARITY=0.3 (prod 500).
    expect(queries[0]).toMatch(/\$3::float8/);
    expect(queries[0]).not.toMatch(/ts_rank/);
    expect(queries[1]).toMatch(/ORDER BY ts_rank/);
  });
});
