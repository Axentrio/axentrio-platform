import { DataSource } from "typeorm";
import { KnowledgeDocument } from "../database/entities/KnowledgeDocument";
import { KnowledgeBase } from "../database/entities/KnowledgeBase";
import { extractText } from "./document-extractors/text.extractor";
import { extractPdf } from "./document-extractors/pdf.extractor";
import { extractDocx } from "./document-extractors/docx.extractor";
import { chunkText } from "./chunking.service";
import { embed, embedBatch } from "./embedding.service";
import { preprocess, passthrough } from "./content-preprocessor.service";
import { config } from "../config/environment";
import { logger } from "../utils/logger";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

interface IngestionJobData {
  documentId: string;
  tenantId: string;
  processingVersion: number;
}

/**
 * Resolve one document's raw text: inline types come from `sourceContent`, file
 * types are downloaded from S3 and run through the per-type extractor. Throws
 * when the document has no reachable content.
 */
async function extractDocumentText(
  doc: KnowledgeDocument,
  s3Client: S3Client | null,
): Promise<string> {
  const inlineTypes: ReadonlySet<string> = new Set(["text", "faq", "url"]);
  if (inlineTypes.has(doc.type)) {
    return extractText(doc.sourceContent || "");
  }
  if (!doc.storagePath) {
    throw new Error(`No content available for document type ${doc.type}`);
  }
  if (!s3Client || !config.s3?.bucket) {
    throw new Error(
      "S3 is not configured but document requires file download",
    );
  }
  const command = new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: doc.storagePath,
  });
  const response = await s3Client.send(command);
  const buffer = Buffer.from(await response.Body!.transformToByteArray());
  return doc.type === "pdf" ? extractPdf(buffer) : extractDocx(buffer);
}

/**
 * Document-level summary chunk for broad queries. The embedding is null when the
 * content is too short to be worth embedding.
 */
async function buildSummaryChunk(tenantId: string, title: string, summaryText: string) {
  const content = summaryText
    ? `[Document: ${title}] ${summaryText}`
    : `[Document: ${title}]`;
  const embedding = content.length > 10 ? await embed(tenantId, content) : null;
  return { content, embedding };
}

export function createIngestionProcessor(
  dataSource: DataSource,
  s3Client: S3Client | null,
) {
  const docRepo = dataSource.getRepository(KnowledgeDocument);
  const kbRepo = dataSource.getRepository(KnowledgeBase);

  return async (job: { data: IngestionJobData }) => {
    const { documentId, tenantId, processingVersion } = job.data;
    logger.info(`Processing document ${documentId} v${processingVersion}`);

    const doc = await docRepo.findOne({ where: { id: documentId, tenantId } });
    if (!doc || doc.processingVersion !== processingVersion) {
      logger.info(`Stale job for document ${documentId}, discarding`);
      return;
    }

    try {
      doc.status = "processing";
      await docRepo.save(doc);

      let text = await extractDocumentText(doc, s3Client);

      if (!text.trim()) {
        throw new Error("No text content found");
      }

      if (text.length > config.rag.maxExtractedChars) {
        text = text.slice(0, config.rag.maxExtractedChars);
        logger.warn(
          `Document ${documentId} text truncated to ${config.rag.maxExtractedChars} chars`,
        );
      }

      // Preprocess: classify and transform content. A document marked
      // `metadata.verbatim` skips it entirely, because the preprocessor REWRITES a
      // price list and REPLACES low-value text with the model's own summary. That is
      // right for a scraped page and wrong for text a business owner typed as their
      // own answer to a customer (see insights/gap-answer.service.ts).
      const verbatim = doc.metadata?.verbatim === true;
      const preprocessResult = verbatim
        ? passthrough(text, 'Verbatim document, published exactly as written.')
        : await preprocess(tenantId, text);
      const processedText = preprocessResult.transformedText;
      logger.info(
        `[Ingestion] Document ${documentId} preprocessed: ${preprocessResult.qualityReport.contentType} (${preprocessResult.qualityReport.qualityScore})${verbatim ? ' [verbatim]' : ''}`,
      );

      // Re-check for stale job after LLM preprocessing
      const freshCheckAfterPreprocess = await docRepo.findOne({
        where: { id: documentId, tenantId },
      });
      if (
        !freshCheckAfterPreprocess ||
        freshCheckAfterPreprocess.processingVersion !== processingVersion
      ) {
        logger.info(
          `Stale job for document ${documentId} after preprocessing, discarding`,
        );
        return;
      }

      // Guard against empty output from preprocessing
      if (!processedText.trim()) {
        doc.status = "indexed";
        doc.chunkCount = 0;
        doc.errorMessage = null;
        doc.qualityReport = {
          ...preprocessResult.qualityReport,
          chunksCreated: 0,
        };
        await docRepo.save(doc);
        logger.warn(
          `[Ingestion] Document ${documentId} produced no usable content after preprocessing`,
        );
        return;
      }

      // Multi-bot: fetch the document's OWN KnowledgeBase (a tenant may now
      // have several), not "the tenant's KB".
      const kb = await kbRepo.findOneOrFail({
        where: { id: doc.knowledgeBaseId },
      });
      let chunks = chunkText(processedText, kb.chunkSize, kb.chunkOverlap);

      if (chunks.length > config.rag.maxChunksPerDoc) {
        logger.warn(
          `Document ${documentId} capped at ${config.rag.maxChunksPerDoc} chunks (had ${chunks.length})`,
        );
        chunks = chunks.slice(0, config.rag.maxChunksPerDoc);
      }

      const embeddings = await embedBatch(tenantId, chunks.map((c) => c.content));

      const freshDoc = await docRepo.findOne({
        where: { id: documentId, tenantId },
      });
      if (!freshDoc || freshDoc.processingVersion !== processingVersion) {
        logger.info(
          `Document ${documentId} version changed during embedding, discarding`,
        );
        return;
      }

      // Create document-level summary chunk for broad queries
      const { content: summaryContent, embedding: summaryEmbedding } =
        await buildSummaryChunk(
          tenantId,
          doc.title,
          preprocessResult.qualityReport.contentSummary,
        );

      await dataSource.transaction(async (manager) => {
        await manager.query(
          `DELETE FROM knowledge_chunks WHERE "documentId" = $1`,
          [documentId],
        );

        for (let i = 0; i < chunks.length; i++) {
          await manager.query(
            `INSERT INTO knowledge_chunks (id, "documentId", "tenantId", content, embedding, tsv, "chunkIndex", "charCount", metadata, "createdAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4::vector, to_tsvector('english', $3), $5, $6, $7, NOW())`,
            [
              documentId,
              tenantId,
              chunks[i].content,
              `[${embeddings[i].join(",")}]`,
              chunks[i].chunkIndex,
              chunks[i].charCount,
              JSON.stringify(chunks[i].metadata),
            ],
          );
        }

        // Insert summary chunk (chunkIndex -1 to distinguish from content chunks)
        if (summaryEmbedding) {
          await manager.query(
            `INSERT INTO knowledge_chunks (id, "documentId", "tenantId", content, embedding, tsv, "chunkIndex", "charCount", metadata, "createdAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4::vector, to_tsvector('english', $3), -1, $5, $6, NOW())`,
            [
              documentId,
              tenantId,
              summaryContent,
              `[${summaryEmbedding.join(",")}]`,
              summaryContent.length,
              JSON.stringify({ type: "document_summary" }),
            ],
          );
        }
      });

      doc.status = "indexed";
      doc.chunkCount = chunks.length;
      doc.errorMessage = null;
      doc.qualityReport = {
        ...preprocessResult.qualityReport,
        chunksCreated: chunks.length,
      };
      await docRepo.save(doc);

      kb.lastIndexedAt = new Date();
      await kbRepo.save(kb);

      logger.info(`Document ${documentId} indexed: ${chunks.length} chunks`);
    } catch (error: any) {
      logger.error(`Failed to process document ${documentId}:`, error);
      doc.status = "failed";
      doc.errorMessage = error.message || "Unknown error";
      await docRepo.save(doc);
      throw error;
    }
  };
}
