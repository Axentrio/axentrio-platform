/**
 * Cloud-import worker. Downloads a provider file, stages it in S3, virus-scans,
 * then creates a KnowledgeDocument and enqueues knowledge-processing.
 */
import type { DataSource } from "typeorm";
import axios from "axios";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../../config/s3.config";
import { config } from "../../config/environment";
import { AppDataSource } from "../../database/data-source";
import { StorageConnection } from "../../database/entities/StorageConnection";
import { StorageImportJob } from "../../database/entities/StorageImportJob";
import { KnowledgeDocument } from "../../database/entities/KnowledgeDocument";
import { getVirusScanService } from "../../file-handling/virus-scan.service";
import { getValidationService } from "../../file-handling/validation.service";
import { addJob } from "../../queue/message-queue";
import { logger } from "../../utils/logger";
import { getValidAccessToken, refresherFor } from "./token";
import { downloadOneDriveContent, fetchOneDriveMeta } from "./onedrive.service";
import {
  KB_DOCX,
  KB_PDF,
  MAX_GOOGLE_EXPORT_BYTES,
  MAX_IMPORT_BYTES,
  planForMime,
  sanitizeFileName,
} from "./import-mime";
import { readCappedStream } from "./capped-stream";

export const STORAGE_IMPORT_QUEUE = "storage-import";

export interface StorageImportJobData {
  /** Set for delayed self-cleanup jobs that delete a superseded S3 key. */
  kind?: "cleanup-key";
  cleanupKey?: string | null;
  jobRowId?: string;
  tenantId: string;
  kbId?: string;
  storageConnectionId?: string;
  provider: string;
  fileId: string;
  /** OneDrive picker v8: drive holding the item (Graph /drives/{driveId}). */
  driveId?: string | null;
  importedBy?: string;
}

export function createStorageImportProcessor(dataSource: DataSource) {
  const jobRepo = dataSource.getRepository(StorageImportJob);
  const connRepo = dataSource.getRepository(StorageConnection);

  return async (job: { data: StorageImportJobData }) => {
    if (job.data.kind === "cleanup-key") {
      await deleteSupersededKey(job.data.tenantId, job.data.cleanupKey);
      return;
    }
    const row = await jobRepo.findOne({ where: { id: job.data.jobRowId } });
    if (!row) return;
    const connection = await connRepo.findOne({
      where: { id: job.data.storageConnectionId, tenantId: job.data.tenantId },
    });
    if (!connection) {
      row.status = "failed";
      row.error = "Storage connection missing";
      await jobRepo.save(row);
      return;
    }

    try {
      if (!config.clamav.enabled) {
        throw Object.assign(new Error("Virus scanning is unavailable"), {
          code: "virus_scanning_unavailable",
        });
      }
      row.status = "downloading";
      await jobRepo.save(row);

      const accessToken = await getValidAccessToken(
        connection,
        refresherFor(connection.provider),
      );
      const downloaded =
        connection.provider === "onedrive"
          ? await downloadOneDriveAsImport(
              accessToken,
              job.data.fileId,
              job.data.driveId,
            )
          : await downloadGoogleFile(accessToken, job.data.fileId);
      const safeName = sanitizeFileName(downloaded.name);
      const stagingKey = `staging/${job.data.tenantId}/${row.id}/${safeName}`;
      const s3 = createS3Client();
      const bucket = config.s3.bucket;

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: stagingKey,
          Body: downloaded.buffer,
          ContentType: downloaded.detectedMime,
        }),
      );

      row.status = "scanning";
      await jobRepo.save(row);
      const scan = await getVirusScanService().scanFile(stagingKey);
      if (!scan.clean) {
        await s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey }),
        );
        row.status = "failed";
        row.error = `Infected file (${(scan.threats || []).join(", ") || "unknown threat"})`;
        await jobRepo.save(row);
        return;
      }

      const validation = await getValidationService().validateFileBuffer(
        downloaded.buffer,
        safeName,
        downloaded.detectedMime,
        job.data.tenantId,
      );
      if (!validation.valid || !validation.detectedMimeType) {
        await s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey }),
        );
        row.status = "failed";
        row.error = validation.errors.join("; ") || "File failed validation";
        await jobRepo.save(row);
        return;
      }
      const allowed = [KB_PDF, KB_DOCX];
      if (!allowed.includes(validation.detectedMimeType)) {
        await s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey }),
        );
        row.status = "failed";
        row.error = "Uploaded file is not a valid PDF or Word document";
        await jobRepo.save(row);
        return;
      }

      // Spec: "bump processingVersion + status pending in ONE transaction".
      // The pessimistic lock, the version reservation, the S3 copy of the new
      // bytes, and the document write all share this transaction, so two
      // concurrent re-imports can never race to the same version or key.
      const { document, previousKey } = await dataSource.transaction(
        async (manager) => {
          const lockedDocRepo = manager.getRepository(KnowledgeDocument);
          const existing = await lockedDocRepo.findOne({
            where: {
              knowledgeBaseId: job.data.kbId,
              storageProvider: job.data.provider,
              storageFileId: job.data.fileId,
            },
            lock: { mode: "pessimistic_write" },
          });
          const nextVersion = existing ? existing.processingVersion + 1 : 1;
          const finalKey = `knowledge/${job.data.tenantId}/${job.data.kbId}/${job.data.provider}/${job.data.fileId}/v${nextVersion}`;

          // Bytes land before the row commits: a crash here rolls both back
          // and leaves only an orphan object the next attempt overwrites.
          await s3.send(
            new CopyObjectCommand({
              Bucket: bucket,
              CopySource: `${bucket}/${stagingKey}`,
              Key: finalKey,
              ContentType: validation.detectedMimeType,
            }),
          );
          await s3.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey }),
          );

          const provenance = {
            source: "cloud",
            provider: job.data.provider,
            storageConnectionId: connection.id,
            providerAccountId: connection.providerAccountId,
            fileId: job.data.fileId,
            fileOwner: downloaded.owner,
            importedBy: job.data.importedBy,
            importedAt: new Date().toISOString(),
          };
          const title = downloaded.name.replace(/\.[^.]+$/, "") || safeName;

          const previousKey = existing?.storagePath ?? null;
          let doc: KnowledgeDocument;
          if (existing) {
            existing.processingVersion = nextVersion;
            existing.status = "pending";
            existing.storagePath = finalKey;
            existing.title = title;
            existing.type = downloaded.docType;
            existing.metadata = { ...existing.metadata, ...provenance };
            existing.errorMessage = null;
            doc = await lockedDocRepo.save(existing);
          } else {
            doc = await lockedDocRepo.save(
              lockedDocRepo.create({
                knowledgeBaseId: job.data.kbId,
                tenantId: job.data.tenantId,
                type: downloaded.docType,
                title,
                sourceContent: null,
                sourceUrl: null,
                storagePath: finalKey,
                storageProvider: job.data.provider,
                storageFileId: job.data.fileId,
                status: "pending",
                processingVersion: 1,
                metadata: provenance,
              }),
            );
          }

          row.targetKey = finalKey;
          row.status = "stored";
          await manager.getRepository(StorageImportJob).save(row);
          return {
            document: doc,
            previousKey,
          };
        },
      );

      await addJob(
        "knowledge-processing",
        {
          documentId: document.id,
          tenantId: job.data.tenantId,
          processingVersion: document.processingVersion,
        },
        { jobId: `kb-${document.id}-v${document.processingVersion}` },
      );

      if (previousKey && previousKey !== document.storagePath) {
        // Spec: delete the superseded key only after indexing. Indexing is
        // async and ingestion.worker must stay untouched, so schedule the
        // deletion a day out — safely after any index run — and let the
        // handler skip keys a document references again in the meantime.
        try {
          await addJob(
            STORAGE_IMPORT_QUEUE,
            {
              kind: "cleanup-key",
              tenantId: job.data.tenantId,
              provider: job.data.provider,
              fileId: job.data.fileId,
              cleanupKey: previousKey,
            },
            {
              jobId: `storage-cleanup-${document.id}-v${document.processingVersion}`,
              delay: 24 * 60 * 60 * 1000,
            },
          );
        } catch (cleanupErr) {
          logger.warn("[storage-import] cleanup scheduling failed", {
            cleanupKey: previousKey,
            error:
              cleanupErr instanceof Error
                ? cleanupErr.message
                : String(cleanupErr),
          });
        }
      }
      row.status = "document_created";
      row.documentId = document.id;
      row.error = null;
      await jobRepo.save(row);
    } catch (error) {
      logger.error("[storage-import] job failed", {
        jobRowId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      row.status = "failed";
      row.error = error instanceof Error ? error.message : "Import failed";
      await jobRepo.save(row);
      throw error;
    }
  };
}

async function downloadOneDriveAsImport(
  accessToken: string,
  fileId: string,
  driveId?: string | null,
): Promise<{
  buffer: Buffer;
  name: string;
  detectedMime: string;
  docType: 'pdf' | 'docx';
  owner: string | null;
}> {
  const meta = await fetchOneDriveMeta(accessToken, fileId, driveId);
  const plan = planForMime(meta.mimeType);
  if (!plan || plan.kind !== 'media') {
    throw new Error('File type is not supported');
  }
  const buffer = await downloadOneDriveContent(accessToken, fileId, driveId);
  return {
    buffer,
    name: meta.name,
    detectedMime: plan.detectedMime,
    docType: plan.docType,
    owner: null,
  };
}

/**
 * Delete a superseded version key unless a document references it again (a
 * re-import between scheduling and firing may have revived the same bytes).
 */
async function deleteSupersededKey(
  tenantId: string | undefined,
  key: string | null | undefined,
): Promise<void> {
  if (!key || !config.s3?.bucket) return;
  const referenced = await AppDataSource.getRepository(
    KnowledgeDocument,
  ).findOne({ where: { storagePath: key } });
  if (referenced) {
    logger.info("[storage-import] cleanup skipped, key referenced again", {
      cleanupKey: key,
    });
    return;
  }
  await createS3Client().send(
    new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }),
  );
  logger.info("[storage-import] superseded key deleted", {
    tenantId,
    cleanupKey: key,
  });
}

async function downloadGoogleFile(
  accessToken: string,
  fileId: string,
): Promise<{
  buffer: Buffer;
  name: string;
  detectedMime: string;
  docType: "pdf" | "docx";
  owner: string | null;
}> {
  const meta = await axios.get(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        fields: "id,name,mimeType,size,owners",
      },
      timeout: 15000,
    },
  );
  const mime = String(meta.data.mimeType || "");
  const plan = planForMime(mime);
  if (!plan) {
    throw new Error("File type is not supported");
  }
  const claimedSize = meta.data.size ? Number(meta.data.size) : null;
  if (claimedSize && claimedSize > MAX_IMPORT_BYTES) {
    throw new Error("File exceeds the 25 MB limit");
  }
  const cap =
    plan.kind === "export" ? MAX_GOOGLE_EXPORT_BYTES : MAX_IMPORT_BYTES;
  const url =
    plan.kind === "export"
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
  const params =
    plan.kind === "export" ? { mimeType: plan.exportMime } : { alt: "media" };

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
    responseType: "stream",
    timeout: 60000,
    maxRedirects: 0,
    validateStatus: (s) => s < 500,
  });
  if (res.status === 403) {
    throw new Error(
      "Google could not export this file (it may be larger than 10 MB)",
    );
  }
  if (res.status !== 200) {
    throw new Error(`Google Drive download failed (${res.status})`);
  }
  const buffer = await readCappedStream(res.data, cap);
  const owner =
    Array.isArray(meta.data.owners) && meta.data.owners[0]?.emailAddress
      ? String(meta.data.owners[0].emailAddress)
      : null;
  return {
    buffer,
    name: String(meta.data.name || "file"),
    detectedMime: plan.detectedMime,
    docType: plan.docType,
    owner,
  };
}

