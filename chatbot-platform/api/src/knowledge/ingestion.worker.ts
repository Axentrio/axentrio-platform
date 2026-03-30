import { DataSource } from 'typeorm';
import { KnowledgeDocument } from '../database/entities/KnowledgeDocument';
import { KnowledgeBase } from '../database/entities/KnowledgeBase';
import { extractText } from './document-extractors/text.extractor';
import { extractPdf } from './document-extractors/pdf.extractor';
import { extractDocx } from './document-extractors/docx.extractor';
import { chunkText } from './chunking.service';
import { embedBatch } from './embedding.service';
import { preprocess } from './content-preprocessor.service';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

interface IngestionJobData {
  documentId: string;
  tenantId: string;
  processingVersion: number;
}

export function createIngestionProcessor(dataSource: DataSource, s3Client: S3Client | null) {
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
      doc.status = 'processing';
      await docRepo.save(doc);

      let text: string;
      if (doc.type === 'text' || doc.type === 'faq') {
        text = extractText(doc.sourceContent || '');
      } else if (doc.storagePath) {
        if (!s3Client || !config.s3?.bucket) {
          throw new Error('S3 is not configured but document requires file download');
        }
        const command = new GetObjectCommand({
          Bucket: config.s3.bucket,
          Key: doc.storagePath,
        });
        const response = await s3Client.send(command);
        const buffer = Buffer.from(await response.Body!.transformToByteArray());

        if (doc.type === 'pdf') {
          text = await extractPdf(buffer);
        } else {
          text = await extractDocx(buffer);
        }
      } else {
        throw new Error(`No content available for document type ${doc.type}`);
      }

      if (!text.trim()) {
        throw new Error('No text content found');
      }

      if (text.length > config.rag.maxExtractedChars) {
        text = text.slice(0, config.rag.maxExtractedChars);
        logger.warn(`Document ${documentId} text truncated to ${config.rag.maxExtractedChars} chars`);
      }

      // Preprocess: classify and transform content
      const preprocessResult = await preprocess(text);
      const processedText = preprocessResult.transformedText;
      logger.info(`[Ingestion] Document ${documentId} preprocessed: ${preprocessResult.qualityReport.contentType} (${preprocessResult.qualityReport.qualityScore})`);

      // Re-check for stale job after LLM preprocessing
      const freshCheckAfterPreprocess = await docRepo.findOne({ where: { id: documentId, tenantId } });
      if (!freshCheckAfterPreprocess || freshCheckAfterPreprocess.processingVersion !== processingVersion) {
        logger.info(`Stale job for document ${documentId} after preprocessing, discarding`);
        return;
      }

      // Guard against empty output from preprocessing
      if (!processedText.trim()) {
        doc.status = 'indexed';
        doc.chunkCount = 0;
        doc.errorMessage = null;
        doc.qualityReport = { ...preprocessResult.qualityReport, chunksCreated: 0 };
        await docRepo.save(doc);
        logger.warn(`[Ingestion] Document ${documentId} produced no usable content after preprocessing`);
        return;
      }

      const kb = await kbRepo.findOneOrFail({ where: { tenantId } });
      let chunks = chunkText(processedText, kb.chunkSize, kb.chunkOverlap);

      if (chunks.length > config.rag.maxChunksPerDoc) {
        logger.warn(`Document ${documentId} capped at ${config.rag.maxChunksPerDoc} chunks (had ${chunks.length})`);
        chunks = chunks.slice(0, config.rag.maxChunksPerDoc);
      }

      const embeddings = await embedBatch(chunks.map((c) => c.content));

      const freshDoc = await docRepo.findOne({ where: { id: documentId, tenantId } });
      if (!freshDoc || freshDoc.processingVersion !== processingVersion) {
        logger.info(`Document ${documentId} version changed during embedding, discarding`);
        return;
      }

      await dataSource.transaction(async (manager) => {
        await manager.query(`DELETE FROM knowledge_chunks WHERE "documentId" = $1`, [documentId]);

        for (let i = 0; i < chunks.length; i++) {
          await manager.query(
            `INSERT INTO knowledge_chunks (id, "documentId", "tenantId", content, embedding, "chunkIndex", "charCount", metadata, "createdAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4::vector, $5, $6, $7, NOW())`,
            [
              documentId,
              tenantId,
              chunks[i].content,
              `[${embeddings[i].join(',')}]`,
              chunks[i].chunkIndex,
              chunks[i].charCount,
              JSON.stringify(chunks[i].metadata),
            ]
          );
        }
      });

      doc.status = 'indexed';
      doc.chunkCount = chunks.length;
      doc.errorMessage = null;
      doc.qualityReport = { ...preprocessResult.qualityReport, chunksCreated: chunks.length };
      await docRepo.save(doc);

      kb.lastIndexedAt = new Date();
      await kbRepo.save(kb);

      logger.info(`Document ${documentId} indexed: ${chunks.length} chunks`);
    } catch (error: any) {
      logger.error(`Failed to process document ${documentId}:`, error);
      doc.status = 'failed';
      doc.errorMessage = error.message || 'Unknown error';
      await docRepo.save(doc);
      throw error;
    }
  };
}
