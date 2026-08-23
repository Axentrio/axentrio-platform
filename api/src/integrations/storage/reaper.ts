/**
 * Daily reaper for cloud-import artifacts (plan v4, Billing + ops).
 *
 * Deletes S3 objects whose storage_import_jobs row is stuck in
 * failed/downloading for more than 24h, plus stray staging/ objects older
 * than a day. Bounded work per run; failures log and continue.
 */
import { LessThan, MoreThan } from "typeorm";
import { AppDataSource } from "../../database/data-source";
import { StorageImportJob } from "../../database/entities/StorageImportJob";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createS3Client } from "../../config/s3.config";
import { config } from "../../config/environment";
import { logger } from "../../utils/logger";

const STUCK_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 900;

export async function reapStaleStorageImports(): Promise<{
  deletedJobs: number;
  deletedStaging: number;
}> {
  if (!config.s3?.bucket) return { deletedJobs: 0, deletedStaging: 0 };
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
  const jobRepo = AppDataSource.getRepository(StorageImportJob);
  const stuck = await jobRepo.find({
    where: [
      { status: "failed", updatedAt: MoreThan(new Date(0)) },
      { status: "downloading", updatedAt: LessThan(cutoff) },
      { status: "scanning", updatedAt: LessThan(cutoff) },
    ],
    take: 200,
  });
  const s3 = createS3Client();
  const bucket = config.s3.bucket;
  let deletedJobs = 0;

  for (const job of stuck) {
    try {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: [{ Key: job.targetKey }],
            Quiet: true,
          },
        }),
      );
      deletedJobs += 1;
    } catch (err) {
      logger.warn("[storage-reaper] job key delete failed", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let deletedStaging = 0;
  let continuation: string | undefined;
  try {
    for (;;) {
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: "staging/",
          MaxKeys: MAX_KEYS,
          ContinuationToken: continuation,
        }),
      );
      const cutoffMs = cutoff.getTime();
      const stale = (listed.Contents || []).filter(
        (o) => o.Key && o.LastModified && o.LastModified.getTime() < cutoffMs,
      );
      if (stale.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: stale.map((o) => ({ Key: o.Key! })),
              Quiet: true,
            },
          }),
        );
        deletedStaging += stale.length;
      }
      continuation = listed.IsTruncated
        ? listed.NextContinuationToken
        : undefined;
      if (!continuation) break;
    }
  } catch (err) {
    logger.warn("[storage-reaper] staging sweep failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (deletedJobs || deletedStaging) {
    logger.info("[storage-reaper] swept", { deletedJobs, deletedStaging });
  }
  return { deletedJobs, deletedStaging };
}

/**
 * GDPR: delete every cloud-import S3 object belonging to a tenant.
 * Exported for the tenant-deletion path; no hard tenant-delete route exists
 * today, so callers invoke this alongside their own tenant cleanup.
 */
export async function purgeTenantStorageObjects(tenantId: string): Promise<number> {
  if (!config.s3?.bucket) return 0;
  const s3 = createS3Client();
  const bucket = config.s3.bucket;
  let deleted = 0;
  for (const prefix of [`knowledge/${tenantId}/`, `staging/${tenantId}/`]) {
    let continuation: string | undefined;
    try {
      do {
        const listed = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: MAX_KEYS,
            ContinuationToken: continuation,
          }),
        );
        const objects = (listed.Contents || []).filter((o) => o.Key);
        if (objects.length > 0) {
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects.map((o) => ({ Key: o.Key! })), Quiet: true },
            }),
          );
          deleted += objects.length;
        }
        continuation = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (continuation);
    } catch (err) {
      logger.warn("[storage-reaper] tenant purge failed", {
        tenantId,
        prefix,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info("[storage-reaper] purged tenant storage objects", { tenantId, deleted });
  return deleted;
}
