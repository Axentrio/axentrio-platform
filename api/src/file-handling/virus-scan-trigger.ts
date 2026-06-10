/**
 * Virus-scan trigger — single source of truth for "scan an uploaded file and
 * react to the result".
 *
 * Two consumers:
 *   1. `routes/files.routes.ts` POST /:sessionId/upload-complete — the
 *      client-driven path. Awaits the result and surfaces it to the caller.
 *      The portal calls this AFTER the S3 PUT completes, so the file is
 *      guaranteed to exist by the time we GET it.
 *   2. `file-handling/upload.controller.ts` (currently unmounted) — the
 *      fire-and-forget path that triggers a scan opportunistically right
 *      after `generateUploadUrl`. That path races with the client's PUT
 *      and almost always fails locally; the real scan happens via the
 *      `POST /webhook/scan-complete` external-scanner callback. We keep
 *      the inline trigger for symmetry with the unmounted router so when
 *      that router gets mounted (or its endpoints get folded in), the
 *      semantics are uniform.
 *
 * Both consumers MUST go through this module so the side effects
 * (status updates, audit logs, thumbnail generation, deletion of infected
 * files) stay consistent.
 */

import { getUploadService } from './upload.service';
import { getVirusScanService, type ScanResult } from './virus-scan.service';
import { getThumbnailService } from './thumbnail.service';
import { logger } from '../utils/logger';
import { logAudit } from '../utils/audit';

const FIRE_AND_FORGET_TIMEOUT_MS = 60_000;
// Tight enough to fit under the global apiRouter `timeoutMiddleware(30_000)`
// at server.ts:215 with a 5s buffer for the JSON response trip back to the
// client (codex round PR1 #3). Scans of 25 MB files via ClamAV streaming
// typically complete in <1s; this only kicks in for genuinely stuck scans.
const SYNC_SCAN_TIMEOUT_MS = 25_000;

// In-flight scan promises keyed by sessionId. Deduplicates concurrent
// /upload-complete calls (codex round PR1 #2). NOTE: per-process only —
// horizontal scaling means a request hitting a different replica won't see
// the in-flight entry. For cross-process dedup we'd need a Redis SETNX lock;
// out of scope for v1 because the realistic concurrent-retry surface is a
// single portal client double-clicking, not multi-replica races.
const inFlightScans = new Map<string, Promise<ScanResult>>();

/**
 * Scan an uploaded file. Updates session status, emits audit logs, and
 * (on clean scan) generates a thumbnail; (on infected scan) deletes the
 * file from S3.
 *
 * Wraps the scan in a {@link SYNC_SCAN_TIMEOUT_MS} timeout so the
 * client-facing /upload-complete handler can't hang past the global API
 * timeout. Deduplicates concurrent calls per sessionId so two simultaneous
 * /upload-complete requests can't emit duplicate audits or double-delete
 * an infected file.
 *
 * Throws on any underlying failure — the caller MUST await and handle
 * errors. Use {@link triggerScanAsync} for the fire-and-forget variant.
 *
 * Returns the canonical ScanResult so callers can surface threats / scan
 * method / duration to the client.
 *
 * **Known limitation — TOCTOU on presigned URL re-upload** (codex round
 * PR1 #1): the S3 presigned PUT URL is valid until its expiry window. A
 * malicious client could upload a clean file, pass the scan, then re-upload
 * a malicious payload to the same key while the session is marked `ready`.
 * v1 mitigation: rely on short presigned-URL TTLs (set in upload.service).
 * Real fix needs ETag/version pinning at scan time + ETag verification when
 * preview/download URLs are minted — tracked as a separate security ticket.
 */
export async function performScan(
  sessionId: string,
  fileKey: string,
): Promise<ScanResult> {
  // Dedup concurrent calls for the same session — if a scan is already
  // running, return its promise instead of starting a new one. Avoids
  // duplicate audit emissions / double-deletes.
  const existing = inFlightScans.get(sessionId);
  if (existing) return existing;

  const promise = (async () => {
    // Track the timeout handle so we can clear it when doScan wins the
    // race. Otherwise the setTimeout would leak per call — both wasteful
    // and a real source of test hangs (vitest waits for all pending
    // timers).
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        doScan(sessionId, fileKey),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Scan timeout')),
            SYNC_SCAN_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      inFlightScans.delete(sessionId);
    }
  })();

  inFlightScans.set(sessionId, promise);
  return promise;
}

async function doScan(
  sessionId: string,
  fileKey: string,
): Promise<ScanResult> {
  const uploadService = getUploadService();
  const virusScanService = getVirusScanService();
  const thumbnailService = getThumbnailService();

  const session = await uploadService.getSession(sessionId);
  if (!session) {
    throw new Error(`Upload session ${sessionId} not found`);
  }

  // Move session into 'scanning' so a concurrent caller sees the state.
  await uploadService.updateSessionStatus(sessionId, 'scanning');

  let scanResult: ScanResult;
  try {
    scanResult = await virusScanService.scanFile(fileKey);
  } catch (error) {
    // Scanner failure — mark session 'failed' so the file is not promoted
    // to 'ready' and the client knows the scan was inconclusive.
    await uploadService.updateSessionStatus(sessionId, 'failed');
    logger.error('Virus scan threw', { sessionId, fileKey, error });
    throw error;
  }

  if (scanResult.clean) {
    await uploadService.updateSessionStatus(sessionId, 'ready', scanResult);
    logAudit(
      session.userId,
      'FILE_SCAN_COMPLETED',
      'upload',
      sessionId,
      session.tenantId,
      {
        fileKey,
        clean: true,
        scanMethod: scanResult.scanMethod,
        durationMs: scanResult.scanDurationMs,
      },
    );

    // Thumbnail is best-effort and slow (Sharp + S3), so generate it OFF the
    // scan-response path: the client gets its 'ready' result as soon as the
    // scan clears, and the thumbnail lands shortly after. Failure is logged,
    // never fatal, and never downgrades the scan result.
    if (thumbnailService.shouldGenerateThumbnail(session.mimeType)) {
      void (async () => {
        try {
          const thumbnailUrl = await thumbnailService.generateThumbnail(
            fileKey,
            session.mimeType,
          );
          // generateThumbnail returns '' when the source was smaller than every
          // configured size (nothing generated) — only persist a real URL.
          if (thumbnailUrl) {
            await uploadService.setThumbnailUrl(sessionId, thumbnailUrl);
          }
        } catch (error) {
          logger.error('Thumbnail generation error', {
            error,
            fileKey,
            sessionId,
            mimeType: session.mimeType,
          });
        }
      })();
    }
  } else {
    await uploadService.updateSessionStatus(sessionId, 'quarantined', scanResult);
    logAudit(
      session.userId,
      'FILE_QUARANTINED',
      'upload',
      sessionId,
      session.tenantId,
      {
        fileKey,
        threats: scanResult.threats ?? [],
        severity: 'HIGH',
      },
    );

    // Delete the infected file from S3. If the delete fails (e.g. transient
    // S3 error), we log and continue — the session is already marked
    // 'quarantined' so the file won't be served to users.
    try {
      await uploadService.deleteFile(fileKey);
    } catch (error) {
      logger.error('Failed to delete quarantined file from S3', {
        sessionId,
        fileKey,
        error,
      });
    }
  }

  return scanResult;
}

/**
 * Fire-and-forget wrapper around {@link performScan} with a 60-second
 * timeout. Swallows all errors via `logger.error` so an unhandled rejection
 * cannot crash the process.
 *
 * Use this when you do NOT want to block the caller's response on the scan
 * (e.g. the post-generateUploadUrl opportunistic trigger). The new
 * client-driven /upload-complete endpoint should use {@link performScan}
 * directly so it can surface the result.
 */
export function triggerScanAsync(sessionId: string, fileKey: string): void {
  // Wrapped in an IIFE so we can attach a top-level catch without `void`-
  // suppressing legitimate failures inside `doScan`. The async path uses
  // its own 60s timeout (more generous than the sync path's 25s — no
  // client is waiting on this response).
  void (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        doScan(sessionId, fileKey),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Virus scan timeout')),
            FIRE_AND_FORGET_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      logger.error('Virus scan failed (async path)', {
        sessionId,
        fileKey,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
}
