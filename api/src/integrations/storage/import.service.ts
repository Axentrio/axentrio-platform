/**
 * Enqueue cloud-storage file imports. HTTP path never downloads bytes.
 */
import { In } from "typeorm";
import { AppDataSource } from "../../database/data-source";
import { StorageConnection } from "../../database/entities/StorageConnection";
import { StorageImportJob } from "../../database/entities/StorageImportJob";
import { KnowledgeService } from "../../knowledge/knowledge.service";
import { addJob, removeJob } from "../../queue/message-queue";
import { getValidAccessToken, refresherFor } from "./token";
import { config } from "../../config/environment";
import { ApiError, BadRequestError } from "../../middleware/error-handler";
import { ERROR_CODES } from "../../middleware/error-codes";
import { logger } from "../../utils/logger";
import axios from "axios";
import {
  MAX_IMPORT_FILES,
  MAX_RUNNING_JOBS_PER_TENANT,
  planForMime,
} from "./import-mime";
import { STORAGE_IMPORT_QUEUE } from "./import.worker";

export interface ImportFileInput {
  id: string;
  name?: string;
  mimeType?: string;
  size?: number;
  /** OneDrive picker v8: drive holding the item (Graph /drives/{driveId}). */
  driveId?: string;
}

export async function enqueueStorageImport(opts: {
  tenantId: string;
  userId: string;
  kbId?: string;
  storageConnectionId: string;
  files: ImportFileInput[];
  googleAccessToken?: string;
}): Promise<{
  jobs: Array<{ id: string; fileId: string; status: string }>;
  skipped: Array<{ id: string; reason: string }>;
}> {
  if (!config.clamav.enabled) {
    throw new ApiError(
      "Virus scanning is unavailable",
      503,
      "virus_scanning_unavailable",
    );
  }
  if (!config.s3?.bucket) {
    throw new ApiError(
      "File storage is not configured",
      503,
      ERROR_CODES.FILE_SERVICE_UNAVAILABLE,
    );
  }
  if (!Array.isArray(opts.files) || opts.files.length === 0) {
    throw new BadRequestError("Select at least one file");
  }
  if (opts.files.length > MAX_IMPORT_FILES) {
    throw new BadRequestError(
      `Import at most ${MAX_IMPORT_FILES} files at a time`,
    );
  }

  const connRepo = AppDataSource.getRepository(StorageConnection);
  const connection = await connRepo.findOne({
    where: {
      id: opts.storageConnectionId,
      tenantId: opts.tenantId,
      status: "active",
    },
  });
  if (!connection) {
    throw new BadRequestError("Storage connection not found");
  }
  if (connection.reauthRequired) {
    throw new ApiError(
      "Reconnect this cloud account",
      409,
      "STORAGE_REAUTH_REQUIRED",
    );
  }
  if (connection.provider === "google_drive") {
    await assertGoogleAccountMatch(
      connection.providerAccountId,
      opts.googleAccessToken,
    );
  } else {
    await assertOneDriveAccountMatch(connection);
  }

  const knowledge = new KnowledgeService(AppDataSource);
  const kb = await knowledge.resolveKnowledgeBase(opts.tenantId, opts.kbId);
  const remaining = await knowledge.remainingDocumentSlots(
    opts.tenantId,
    kb.id,
  );
  if (remaining <= 0 || opts.files.length > remaining) {
    throw new ApiError(
      "Document limit reached for this plan",
      402,
      ERROR_CODES.QUOTA_EXCEEDED,
    );
  }
  const jobRepo = AppDataSource.getRepository(StorageImportJob);
  // Spec volume gate: at most MAX_RUNNING_JOBS_PER_TENANT jobs in flight per
  // tenant. A fresh selection may queue beyond the cap — the storage-import
  // processor runs at low global concurrency, so queued rows drain bounded.
  const running = await jobRepo.count({
    where: {
      tenantId: opts.tenantId,
      status: In(["queued", "downloading", "scanning"]),
    },
  });
  if (running >= MAX_RUNNING_JOBS_PER_TENANT) {
    throw new ApiError(
      "Too many imports in progress. Wait for the current ones to finish.",
      429,
      "RATE_LIMIT_EXCEEDED",
    );
  }

  const created: Array<{ id: string; fileId: string; status: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const file of opts.files) {
    if (!file.id || typeof file.id !== "string") {
      throw new BadRequestError("Each file needs an id");
    }
    // Skip unsupported files (folders, images, ...) instead of failing the
    // whole selection — users pick stray items without noticing.
    if (file.mimeType && !planForMime(file.mimeType)) {
      skipped.push({ id: file.id, reason: "unsupported_type" });
      continue;
    }
    const targetKey = `knowledge/${opts.tenantId}/${kb.id}/${connection.provider}/${file.id}/v1`;
    let job = await jobRepo.findOne({
      where: {
        knowledgeBaseId: kb.id,
        provider: connection.provider,
        fileId: file.id,
      },
      order: { createdAt: "DESC" },
    });
    if (!job || job.status === "document_created" || job.status === "failed") {
      job = jobRepo.create({
        tenantId: opts.tenantId,
        knowledgeBaseId: kb.id,
        storageConnectionId: connection.id,
        provider: connection.provider,
        fileId: file.id,
        targetKey,
        status: "queued",
        error: null,
        documentId: null,
      });
      job = await jobRepo.save(job);
    } else if (
      job.status === "queued" ||
      job.status === "downloading" ||
      job.status === "scanning" ||
      job.status === "stored"
    ) {
      created.push({ id: job.id, fileId: file.id, status: job.status });
      continue;
    }
    const jobId = `import-${kb.id}-${connection.provider}-${file.id}`;
    // The deterministic jobId stays stable across re-imports (spec), but Bull
    // keeps completed/failed job hashes (removeOnComplete: 100) and silently
    // ignores a duplicate jobId. Drop any stale job with this id first, or the
    // fresh row would sit "queued" forever.
    await removeJob(STORAGE_IMPORT_QUEUE, jobId);
    try {
      await addJob(
        STORAGE_IMPORT_QUEUE,
        {
          jobRowId: job.id,
          tenantId: opts.tenantId,
          kbId: kb.id,
          storageConnectionId: connection.id,
          provider: connection.provider,
          fileId: file.id,
          driveId: file.driveId ?? null,
          importedBy: opts.userId,
          claimedName: file.name ?? null,
          claimedMime: file.mimeType ?? null,
          claimedSize: file.size ?? null,
        },
        { jobId },
      );
    } catch (error) {
      logger.error("[storage-import] queue failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ApiError(
        "Could not queue the cloud import",
        503,
        "queue_unavailable",
      );
    }
    created.push({ id: job.id, fileId: file.id, status: job.status });
  }
  if (created.length === 0) {
    throw new BadRequestError("No importable files in that selection");
  }
  return { jobs: created, skipped };
}

async function assertGoogleAccountMatch(
  providerAccountId: string,
  googleAccessToken: string | undefined,
): Promise<void> {
  if (!googleAccessToken) {
    throw new ApiError(
      "Google account proof is required",
      400,
      "storage_account_mismatch",
    );
  }
  let sub: string | undefined;
  try {
    const me = await axios.get(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${googleAccessToken}` },
        timeout: 8000,
      },
    );
    sub = me.data?.sub;
  } catch {
    throw new ApiError(
      "Google account proof is required",
      400,
      "storage_account_mismatch",
    );
  }
  if (!sub || sub !== providerAccountId) {
    throw new ApiError(
      "Google account does not match the connected Drive",
      400,
      "storage_account_mismatch",
    );
  }
}

/**
 * Bind the picker selection to the stored connection: the Graph identity of
 * the connection's own token must equal the stored providerAccountId, so a
 * picker pointed at a different account cannot import into this tenant.
 */
async function assertOneDriveAccountMatch(
  connection: StorageConnection,
): Promise<void> {
  const accessToken = await getValidAccessToken(
    connection,
    refresherFor(connection.provider),
  );
  let id: string | undefined;
  try {
    const me = await axios.get("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 8000,
    });
    id = me.data?.id;
  } catch {
    throw new ApiError(
      "OneDrive account proof failed",
      400,
      "storage_account_mismatch",
    );
  }
  if (!id || id !== connection.providerAccountId) {
    throw new ApiError(
      "OneDrive account does not match the connected drive",
      400,
      "storage_account_mismatch",
    );
  }
}
