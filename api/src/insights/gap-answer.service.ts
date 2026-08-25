/**
 * Answering a Gap - the step that closes the insight loop.
 *
 * The pipeline already finds topics the bot could not answer (judge -> Gap ->
 * recommendation). Everything after that was manual: read the advice, go to the
 * Knowledge page, write a document, hope it matches. This publishes the owner's answer
 * straight from the Gap and records which document did it.
 *
 * Three properties this file exists to guarantee:
 *
 * 1. VERBATIM. The document carries `metadata.verbatim`, so the ingestion worker skips
 *    the content preprocessor. Without that flag any answer of 200 characters or more
 *    goes through gpt-4o-mini, which rewrites a price list and replaces "low value" text
 *    with the model's own summary - so a promise the owner made would reach the customer
 *    as a paraphrase.
 * 2. RETRIEVABLE OR NOTHING. Indexing runs inline and the document must end up with
 *    chunks. A document can reach status 'indexed' with zero chunks, which reads as
 *    success everywhere and is invisible to retrieval. On any failure the document is
 *    removed and the Gap stays unanswered, so a retry cannot pile up duplicates or burn
 *    the tier's document allowance.
 * 3. ONE ANSWER, AND ONLY WHILE IT EXISTS. `gap.answerDocumentId` is the flag, not
 *    `answeredAt`. The FK is ON DELETE SET NULL, so deleting the document reopens the
 *    Gap for answering - correct, because the topic is unanswered once the text is gone.
 *
 * The Gap status is deliberately NOT changed. Only the judgments decide whether a topic
 * is really answered (see the lifecycle comment on the Gap entity).
 */
import { AppDataSource } from '../database/data-source';
import { CanonicalTopic } from '../database/entities/CanonicalTopic';
import { Gap } from '../database/entities/Gap';
import { KnowledgeDocument } from '../database/entities/KnowledgeDocument';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { createIngestionProcessor } from '../knowledge/ingestion.worker';
import { ApiError, NotFoundError } from '../middleware/error-handler';
import { logger } from '../utils/logger';

export interface GapAnswerResult {
  id: string;
  answerDocumentId: string;
  answeredAt: Date;
}

/** Publish `answer` as the tenant's knowledge, and point the Gap at it. */
export async function answerGap(
  tenantId: string,
  gapId: string,
  answer: string,
): Promise<GapAnswerResult> {
  const gapRepo = AppDataSource.getRepository(Gap);
  const gap = await gapRepo.findOne({ where: { id: gapId, tenantId } });
  if (!gap) throw new NotFoundError('Gap not found');
  if (gap.answerDocumentId) {
    throw new ApiError(
      'This topic already has a published answer. Edit or delete that document to change it.',
      409,
      'GAP_ALREADY_ANSWERED',
      { answerDocumentId: gap.answerDocumentId },
    );
  }

  const topic = await AppDataSource.getRepository(CanonicalTopic).findOne({
    where: { id: gap.canonicalTopicId, tenantId },
    select: ['topic'],
  });
  if (!topic) throw new NotFoundError('Gap topic not found');

  const knowledge = new KnowledgeService(AppDataSource);
  let document: KnowledgeDocument;
  try {
    document = await knowledge.createDocument(tenantId, {
      type: 'text',
      title: topic.topic,
      // The topic rides along in the body so the keyword branch of retrieval can match
      // the customer's own words, not only the answer's.
      sourceContent: `${topic.topic}\n\n${answer}`,
      metadata: { verbatim: true, source: 'gap_answer', gapId },
    });
  } catch (error) {
    // createDocument throws a plain Error for the tier document cap, which the error
    // handler would turn into a 500 and page the on-call channel for a billing outcome.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Document limit reached')) {
      throw new ApiError(message, 409, 'DOCUMENT_LIMIT_REACHED');
    }
    throw error;
  }

  // Inline, not on the queue: `addJob` throws when Redis is down and leaves the document
  // at 'pending' for ever, and `retryDocument` accepts only 'failed'. Inline also means
  // the owner is told the truth now instead of being promised the bot knows something.
  try {
    await createIngestionProcessor(AppDataSource, null)({
      data: {
        documentId: document.id,
        tenantId,
        processingVersion: document.processingVersion,
      },
    });
  } catch (error) {
    await discard(knowledge, tenantId, document.id, gapId, 'indexing threw');
    throw new ApiError(
      'The answer could not be indexed. Nothing was saved, so you can try again.',
      503,
      'INDEXING_FAILED',
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }

  const indexed = await AppDataSource.getRepository(KnowledgeDocument).findOne({
    where: { id: document.id, tenantId },
  });
  if (!indexed || indexed.status !== 'indexed' || indexed.chunkCount < 1) {
    await discard(knowledge, tenantId, document.id, gapId, `status=${indexed?.status} chunks=${indexed?.chunkCount}`);
    throw new ApiError(
      'The answer could not be indexed. Nothing was saved, so you can try again.',
      503,
      'INDEXING_FAILED',
      { status: indexed?.status ?? 'missing', chunkCount: indexed?.chunkCount ?? 0 },
    );
  }

  gap.answerDocumentId = document.id;
  gap.answeredAt = new Date();
  await gapRepo.save(gap);
  logger.info('[gap-answer] published', {
    tenantId,
    gapId,
    documentId: document.id,
    chunks: indexed.chunkCount,
  });

  return { id: gap.id, answerDocumentId: document.id, answeredAt: gap.answeredAt };
}

/** Remove a document that never became retrievable, so a retry starts clean. */
async function discard(
  knowledge: KnowledgeService,
  tenantId: string,
  documentId: string,
  gapId: string,
  why: string,
): Promise<void> {
  logger.warn('[gap-answer] discarding unindexed document', { tenantId, gapId, documentId, why });
  try {
    await knowledge.deleteDocument(tenantId, documentId);
  } catch (error) {
    // Leaves one orphan the owner can delete on the Knowledge page. Never mask the
    // original failure with this one.
    logger.error('[gap-answer] could not remove the unindexed document', {
      tenantId,
      documentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
