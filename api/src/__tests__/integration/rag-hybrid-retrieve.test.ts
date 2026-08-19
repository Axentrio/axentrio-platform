/**
 * Live 500: `1 - $3` made Postgres bind minSimilarity (0.3) as integer.
 * Empty corpus is enough — the bind fails before any row is read.
 *
 * Synchronize skips `embedding` and `tsv` (raw SQL on the entity). Add them
 * here so this file can run the real retrieve SQL.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../knowledge/embedding.service', () => ({
  embed: vi.fn(async () => Array(1536).fill(0.01)),
}));

import { config } from '../../config/environment';
import { AppDataSource } from '../../database/data-source';
import { searchKnowledge } from '../../llm/rag.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const KB_ID = '22222222-2222-4222-8222-222222222222';

describe('RAG hybrid retrieve', () => {
  beforeAll(async () => {
    await AppDataSource.query(
      `ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536)`,
    );
    await AppDataSource.query(
      `ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS tsv tsvector`,
    );
  });

  it('binds a fractional minSimilarity on the HNSW distance filter', async () => {
    expect(config.rag.minSimilarity % 1).not.toBe(0);

    const result = await searchKnowledge(
      AppDataSource,
      TENANT_ID,
      'Wat zijn jullie openingsuren?',
      [],
      5,
      [KB_ID],
    );

    expect(result.chunks).toEqual([]);
    expect(result.totalChunks).toBe(0);
  });
});
