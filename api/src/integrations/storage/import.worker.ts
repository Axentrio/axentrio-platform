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

export const STORAGE_IMPORT_QUEUE = "storage-import";

export interface StorageImportJobData {
  jobRowId: string;
  tenantId: string;
  kbId: string;
  storageConnectionId: string;
  provider: string;
  fileId: string;
  importedBy: string;
  claimedName: string | null;
  claimedMime: string | null;
  claimedSize: number | null;
}

export function createStorageImportProcessor(dataSource: DataSource) {
  const jobRepo = dataSource.getRepository(StorageImportJob);
  const connRepo = dataSource.getRepository(StorageConnection);
  const docRepo = dataSource.getRepository(KnowledgeDocument);

  return async (job: { data: StorageImportJobData }) => {
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
          ? await downloadOneDriveAsImport(accessToken, job.data.fileId)
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

      // Lock the row so concurrent re-imports cannot race to one version.
      const existing = await dataSource.transaction(async (manager) =>
        manager.getRepository(KnowledgeDocument).findOne({
          where: {
            knowledgeBaseId: job.data.kbId,
            storageProvider: job.data.provider,
            storageFileId: job.data.fileId,
          },
          lock: { mode: "pessimistic_write" },
        }),
      );
      const nextVersion = existing ? existing.processingVersion + 1 : 1;
      const finalKey = `knowledge/${job.data.tenantId}/${job.data.kbId}/${job.data.provider}/${job.data.fileId}/v${nextVersion}`;
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
      row.targetKey = finalKey;
      row.status = "stored";
      await jobRepo.save(row);

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
      const docType = downloaded.docType;

      let document: KnowledgeDocument;
      if (existing) {
        existing.processingVersion = nextVersion;
        existing.status = "pending";
        existing.storagePath = finalKey;
        existing.title = title;
        existing.type = docType;
        existing.metadata = { ...existing.metadata, ...provenance };
        existing.errorMessage = null;
        document = await docRepo.save(existing);
      } else {
        document = docRepo.create({
          knowledgeBaseId: job.data.kbId,
          tenantId: job.data.tenantId,
          type: docType,
          title,
          sourceContent: null,
          sourceUrl: null,
          storagePath: finalKey,
          storageProvider: job.data.provider,
          storageFileId: job.data.fileId,
          status: "pending",
          processingVersion: 1,
          metadata: provenance,
        });
        document = await docRepo.save(document);
      }

      await addJob(
        "knowledge-processing",
        {
          documentId: document.id,
          tenantId: job.data.tenantId,
          processingVersion: document.processingVersion,
        },
        { jobId: `kb-${document.id}-v${document.processingVersion}` },
      );
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
): Promise<{
  buffer: Buffer;
  name: string;
  detectedMime: string;
  docType: 'pdf' | 'docx';
  owner: string | null;
}> {
  const meta = await fetchOneDriveMeta(accessToken, fileId);
  const plan = planForMime(meta.mimeType);
  if (!plan || plan.kind !== 'media') {
    throw new Error('File type is not supported');
  }
  const buffer = await downloadOneDriveContent(accessToken, fileId);
  return {
    buffer,
    name: meta.name,
    detectedMime: plan.detectedMime,
    docType: plan.docType,
    owner: null,
  };
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

async function readCappedStream(
  stream: AsyncIterable<Buffer>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    n += buf.length;
    if (n > maxBytes) {
      throw new Error("File exceeds the size limit");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
