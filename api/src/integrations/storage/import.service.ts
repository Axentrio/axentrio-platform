/**
 * Enqueue cloud-storage file imports. HTTP path never downloads bytes.
 */
import { In, type Repository } from "typeorm";
import { AppDataSource } from "../../database/data-source";
import { StorageConnection } from "../../database/entities/StorageConnection";
import { StorageImportJob } from "../../database/entities/StorageImportJob";
import { KnowledgeService } from "../../knowledge/knowledge.service";
import { addJob, removeJob } from "../../queue/message-queue";
import { assertAccountMatch } from "./connections";
import { config } from "../../config/environment";
import { ApiError, BadRequestError } from "../../middleware/error-handler";
import { ERROR_CODES } from "../../middleware/error-codes";
import { logger } from "../../utils/logger";
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

interface StorageImportRequest {
  tenantId: string;
  userId: string;
  kbId?: string;
  storageConnectionId: string;
  files: ImportFileInput[];
  googleAccessToken?: string;
  oneDriveAccessToken?: string;
}

/** Service-level and selection-level gates that must hold before any DB work. */
function assertImportPreconditions(opts: StorageImportRequest): void {
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
}

/**
 * Loads the active connection and proves the picker token belongs to the same
 * cloud account the connection was created with.
 */
async function loadImportConnection(
  opts: StorageImportRequest,
): Promise<StorageConnection> {
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
    await assertAccountMatch({
      providerLabel: "Google",
      meUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
      accountIdField: "sub",
      providerAccountId: connection.providerAccountId,
      pickerAccessToken: opts.googleAccessToken,
    });
  } else {
    await assertAccountMatch({
      providerLabel: "OneDrive",
      meUrl: "https://graph.microsoft.com/v1.0/me",
      accountIdField: "id",
      providerAccountId: connection.providerAccountId,
      pickerAccessToken: opts.oneDriveAccessToken,
    });
  }
  return connection;
}

/** A picked file either lands in the queue, or is reported back as skipped. */
type ImportFileOutcome =
  | { kind: "skipped"; entry: { id: string; reason: string } }
  | { kind: "created"; entry: { id: string; fileId: string; status: string } };

/** Upserts the job row for one picked file and queues its download. */
async function enqueueImportFile(ctx: {
  opts: StorageImportRequest;
  file: ImportFileInput;
  kbId: string;
  connection: StorageConnection;
  jobRepo: Repository<StorageImportJob>;
}): Promise<ImportFileOutcome> {
  const { opts, file, kbId, connection, jobRepo } = ctx;
  if (!file.id || typeof file.id !== "string") {
    throw new BadRequestError("Each file needs an id");
  }
  // Skip unsupported files (folders, images, ...) instead of failing the
  // whole selection — users pick stray items without noticing.
  if (file.mimeType && !planForMime(file.mimeType)) {
    return { kind: "skipped", entry: { id: file.id, reason: "unsupported_type" } };
  }
  const targetKey = `knowledge/${opts.tenantId}/${kbId}/${connection.provider}/${file.id}/v1`;
  let job = await jobRepo.findOne({
    where: {
      knowledgeBaseId: kbId,
      provider: connection.provider,
      fileId: file.id,
    },
    order: { createdAt: "DESC" },
  });
  if (!job || job.status === "document_created" || job.status === "failed") {
    job = jobRepo.create({
      tenantId: opts.tenantId,
      knowledgeBaseId: kbId,
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
    return { kind: "created", entry: { id: job.id, fileId: file.id, status: job.status } };
  }
  const jobId = `import-${kbId}-${connection.provider}-${file.id}`;
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
        kbId,
        storageConnectionId: connection.id,
        provider: connection.provider,
        fileId: file.id,
        driveId: file.driveId ?? null,
        importedBy: opts.userId,
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
  return { kind: "created", entry: { id: job.id, fileId: file.id, status: job.status } };
}

export async function enqueueStorageImport(opts: {
  tenantId: string;
  userId: string;
  kbId?: string;
  storageConnectionId: string;
  files: ImportFileInput[];
  googleAccessToken?: string;
  oneDriveAccessToken?: string;
}): Promise<{
  provider: string;
  jobs: Array<{ id: string; fileId: string; status: string }>;
  skipped: Array<{ id: string; reason: string }>;
}> {
  assertImportPreconditions(opts);

  const connection = await loadImportConnection(opts);

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
    const outcome = await enqueueImportFile({
      opts,
      file,
      kbId: kb.id,
      connection,
      jobRepo,
    });
    if (outcome.kind === "skipped") {
      skipped.push(outcome.entry);
    } else {
      created.push(outcome.entry);
    }
  }
  if (created.length === 0) {
    throw new BadRequestError("No importable files in that selection");
  }
  return { provider: connection.provider, jobs: created, skipped };
}

