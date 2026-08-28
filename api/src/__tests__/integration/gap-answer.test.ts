/**
 * Publishing an owner's answer to a Gap.
 *
 * Against real Postgres, because every property worth having lives in the database: the
 * chunk text, the document status, and the link back to the Gap.
 *
 * The load-bearing case is the first one. The ingestion preprocessor rewrites a price
 * list and REPLACES text it judges low value with the model's own summary, so publishing
 * through the normal path would hand the customer a paraphrase of a promise the owner
 * made. `preprocess` is mocked here to return obvious garbage: if anyone removes the
 * `metadata.verbatim` bypass, the garbage lands in the chunk and this test says so.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../knowledge/embedding.service', () => ({
  embed: vi.fn(async () => Array(1536).fill(0.01)),
  embedBatch: vi.fn(async (_tenantId: string | undefined, texts: string[]) =>
    texts.map(() => Array(1536).fill(0.01)),
  ),
}));

const preprocessSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../knowledge/content-preprocessor.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../knowledge/content-preprocessor.service')>();
  return {
    ...actual,
    preprocess: vi.fn(async () => {
      preprocessSpy.calls += 1;
      return actual.passthrough('REWRITTEN BY THE MODEL', 'mocked');
    }),
  };
});

import { AppDataSource } from '../../database/data-source';
import { Gap } from '../../database/entities/Gap';
import { CanonicalTopic } from '../../database/entities/CanonicalTopic';
import { KnowledgeDocument } from '../../database/entities/KnowledgeDocument';
import { answerGap } from '../../insights/gap-answer.service';
import { createTestTenant } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const TOPIC = 'emergency call-out fee';
const ANSWER =
  'Our call-out fee is 65 euro during office hours and 95 euro at night or at the weekend. '
  + 'The fee covers the first 30 minutes of work. We tell you the price before we start.';

let tenant: Tenant;
let gap: Gap;

async function seedGap(): Promise<Gap> {
  const topicRepo = AppDataSource.getRepository(CanonicalTopic);
  const topic = await topicRepo.save(topicRepo.create({ tenantId: tenant.id, topic: TOPIC }));
  const gapRepo = AppDataSource.getRepository(Gap);
  return gapRepo.save(
    gapRepo.create({
      tenantId: tenant.id,
      canonicalTopicId: topic.id,
      status: 'open',
      severity: 'red',
      occurrences: 4,
      distinctVisitors: 4,
      firstDetectedAt: new Date(),
      lastSeenAt: new Date(),
    }),
  );
}

const chunksOf = (documentId: string): Promise<Array<{ content: string; chunkIndex: number }>> =>
  AppDataSource.query(
    `SELECT content, "chunkIndex" FROM knowledge_chunks WHERE "documentId" = $1 ORDER BY "chunkIndex"`,
    [documentId],
  );

beforeAll(async () => {
  // `synchronize` skips these two: the entity declares them, the worker writes them by
  // raw SQL. Same preparation as rag-hybrid-retrieve.test.ts.
  await AppDataSource.query(`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536)`);
  await AppDataSource.query(`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS tsv tsvector`);
});

beforeEach(async () => {
  preprocessSpy.calls = 0;
  vi.clearAllMocks();
  tenant = await createTestTenant({ tier: 'pro' });
  gap = await seedGap();
});

describe('answering a gap', () => {
  it("publishes the owner's words unchanged and points the gap at the document", async () => {
    const result = await answerGap(tenant.id, gap.id, ANSWER);

    const doc = await AppDataSource.getRepository(KnowledgeDocument).findOneByOrFail({
      id: result.answerDocumentId,
    });
    expect(doc.status).toBe('indexed');
    expect(doc.chunkCount).toBeGreaterThan(0);
    expect(doc.title).toBe(TOPIC);
    expect(doc.metadata).toMatchObject({ verbatim: true, source: 'gap_answer', gapId: gap.id });

    // The whole point: the answer reached the retrieval corpus byte for byte, and the
    // model never saw it.
    const chunks = await chunksOf(doc.id);
    const body = chunks.map((c) => c.content).join('\n');
    expect(body).toContain(ANSWER);
    expect(body).not.toContain('REWRITTEN BY THE MODEL');
    expect(preprocessSpy.calls).toBe(0);
    // The customer's own words ride along, so the keyword branch can match them too.
    expect(body).toContain(TOPIC);

    const after = await AppDataSource.getRepository(Gap).findOneByOrFail({ id: gap.id });
    expect(after.answerDocumentId).toBe(doc.id);
    expect(after.answeredAt).toBeInstanceOf(Date);
    // Only the judgments close a topic. Answering is not a verdict.
    expect(after.status).toBe('open');
  });

  it('still preprocesses a document that is not marked verbatim', async () => {
    // Guards the bypass from becoming global: the mock stands in for the real rewrite,
    // and an ordinary document must still go through it.
    const { KnowledgeService } = await import('../../knowledge/knowledge.service');
    const { createIngestionProcessor } = await import('../../knowledge/ingestion.worker');
    const svc = new KnowledgeService(AppDataSource);
    const doc = await svc.createDocument(tenant.id, {
      type: 'text',
      title: 'ordinary page',
      sourceContent: ANSWER,
    });
    await createIngestionProcessor(AppDataSource, null)({
      data: { documentId: doc.id, tenantId: tenant.id, processingVersion: doc.processingVersion },
    });

    expect(preprocessSpy.calls).toBe(1);
    const body = (await chunksOf(doc.id)).map((c) => c.content).join('\n');
    expect(body).toContain('REWRITTEN BY THE MODEL');
  });

  it('refuses a second answer while the document exists', async () => {
    await answerGap(tenant.id, gap.id, ANSWER);

    await expect(answerGap(tenant.id, gap.id, 'A different answer, long enough to pass.')).rejects.toMatchObject({
      statusCode: 409,
      code: 'GAP_ALREADY_ANSWERED',
    });
    expect(await AppDataSource.getRepository(KnowledgeDocument).countBy({ tenantId: tenant.id })).toBe(1);
  });

  it('lets exactly one of two simultaneous publishes win', async () => {
    // Two tabs, or one impatient retry while the first request is still indexing. The
    // read at the top of answerGap cannot stop this - both calls pass it - so the claim
    // is a conditional UPDATE and the loser removes its own document.
    const results = await Promise.allSettled([
      answerGap(tenant.id, gap.id, ANSWER),
      answerGap(tenant.id, gap.id, 'A second answer, also long enough to pass validation.'),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      code: 'GAP_ALREADY_ANSWERED',
    });

    // The loser's document must not survive: it would be unreachable from the Gap,
    // retrievable by the bot, and one document off the tenant's allowance.
    const docs = await AppDataSource.getRepository(KnowledgeDocument).findBy({ tenantId: tenant.id });
    expect(docs).toHaveLength(1);
    const after = await AppDataSource.getRepository(Gap).findOneByOrFail({ id: gap.id });
    expect(after.answerDocumentId).toBe(docs[0].id);
  });

  it('accepts a new answer once the document is gone', async () => {
    // What the owner does after publishing something wrong: delete it on the Knowledge
    // page. The FK is ON DELETE SET NULL, so the column empties and the topic is
    // unanswered again. Gating on answeredAt instead would leave it unanswerable.
    const first = await answerGap(tenant.id, gap.id, ANSWER);
    const gapRepo = AppDataSource.getRepository(Gap);
    await gapRepo.update(gap.id, { answerDocumentId: null });
    await AppDataSource.getRepository(KnowledgeDocument).delete({ id: first.answerDocumentId });

    const second = await answerGap(tenant.id, gap.id, 'Our call-out fee is now 70 euro at any hour.');

    expect(second.answerDocumentId).not.toBe(first.answerDocumentId);
    const reloaded = await gapRepo.findOneByOrFail({ id: gap.id });
    expect(reloaded.answerDocumentId).toBe(second.answerDocumentId);
  });

  it('leaves nothing behind when indexing fails', async () => {
    const embedding = await import('../../knowledge/embedding.service');
    vi.mocked(embedding.embedBatch).mockRejectedValueOnce(new Error('openai down'));

    await expect(answerGap(tenant.id, gap.id, ANSWER)).rejects.toMatchObject({
      statusCode: 503,
      code: 'INDEXING_FAILED',
    });

    // No half-published document: it would consume a tier slot, sit unreachable, and a
    // retry would add a second one.
    expect(await AppDataSource.getRepository(KnowledgeDocument).countBy({ tenantId: tenant.id })).toBe(0);
    const after = await AppDataSource.getRepository(Gap).findOneByOrFail({ id: gap.id });
    expect(after.answerDocumentId).toBeNull();
    expect(after.answeredAt).toBeNull();
  });

  it('does not answer another tenant\'s gap', async () => {
    const other = await createTestTenant({ tier: 'pro' });

    await expect(answerGap(other.id, gap.id, ANSWER)).rejects.toMatchObject({ statusCode: 404 });
  });
});
