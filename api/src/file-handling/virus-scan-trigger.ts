/**
 * Virus-scan trigger — single source of truth for "scan an uploaded file and
 * react to the result".
 *
 * Two consumers, both client-driven and both AFTER the S3 PUT completes, so the object is
 * guaranteed to exist by the time we GET it:
 *   1. `routes/files.routes.ts` POST /:sessionId/upload-complete — the portal/agent path,
 *      authenticated with Clerk and scoped to the caller's tenant.
 *   2. `routes/widget.ts` POST /files/:sessionId/upload-complete — the widget visitor path,
 *      with tenant and chat session taken from the server-trusted widget token.
 *
 * (A third, unmounted `file-handling/upload.controller.ts` used to be listed here as a
 * fire-and-forget caller. It was dead code and is gone; the real scan for the async case
 * arrives via the `POST /webhook/scan-complete` external-scanner callback.)
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
 * Key the session will read after a clean scan. The client's presigned PUT
 * still targets the original key, so a later overwrite cannot change what we
 * serve. A key that is already a scanned copy is returned unchanged so a retry
 * after a partial write does not copy a copy.
 */
export function scannedCopyKey(fileKey: string): string {
  const slash = fileKey.lastIndexOf('/');
  const base = slash >= 0 ? fileKey.slice(slash + 1) : fileKey;
  const prefix = slash >= 0 ? fileKey.slice(0, slash + 1) : '';
  const dot = base.lastIndexOf('.');
  const name = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  if (name.endsWith('.scanned')) return fileKey;
  return `${prefix}${name}.scanned${ext}`;
}

/**
 * Scan an uploaded file. Updates session status, emits audit logs, and
 * (on clean scan) copies the object off the writable upload key, then
 * generates a thumbnail; (on infected scan) deletes the file from S3.
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
 * After a clean scan the session `file_key` is a copy the client cannot PUT.
 * The original upload key is then deleted. A later overwrite of that PUT URL
 * cannot reach preview, download, or the owner booking email.
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
    await promoteCleanScan(sessionId, fileKey, scanResult, session);
  } else {
    await quarantineInfected(sessionId, fileKey, scanResult, session);
  }

  return scanResult;
}

async function promoteCleanScan(
  sessionId: string,
  fileKey: string,
  scanResult: ScanResult,
  session: { userId: string; tenantId: string; mimeType: string },
): Promise<void> {
  const uploadService = getUploadService();
  const destKey = scannedCopyKey(fileKey);
  if (destKey !== fileKey) {
    try {
      await uploadService.copyObject(fileKey, destKey);
    } catch (error) {
      await uploadService.updateSessionStatus(sessionId, 'failed');
      logger.error('Failed to copy scanned file off the writable upload key', {
        sessionId,
        fileKey,
        destKey,
        error,
      });
      throw error;
    }
  }
  await uploadService.updateSessionStatus(
    sessionId,
    'ready',
    scanResult,
    destKey !== fileKey ? destKey : undefined,
  );
  logAudit(
    session.userId,
    'FILE_SCAN_COMPLETED',
    'upload',
    sessionId,
    session.tenantId,
    {
      fileKey: destKey,
      clean: true,
      scanMethod: scanResult.scanMethod,
      durationMs: scanResult.scanDurationMs,
    },
  );

  if (destKey !== fileKey) {
    try {
      await uploadService.deleteFile(fileKey);
    } catch (error) {
      logger.warn('Failed to delete writable upload key after scan copy (non-fatal)', {
        sessionId,
        fileKey,
        destKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const thumbnailService = getThumbnailService();
  if (!thumbnailService.shouldGenerateThumbnail(session.mimeType)) return;
  // Thumbnail is best-effort and slow (Sharp + S3), so generate it OFF the
  // scan-response path from the scanned key. The original key may already
  // be deleted.
  void (async () => {
    try {
      const thumbnailUrl = await thumbnailService.generateThumbnail(
        destKey,
        session.mimeType,
      );
      if (thumbnailUrl) {
        await uploadService.setThumbnailUrl(sessionId, thumbnailUrl);
      }
    } catch (error) {
      logger.error('Thumbnail generation error', {
        error,
        fileKey: destKey,
        sessionId,
        mimeType: session.mimeType,
      });
    }
  })();
}

async function quarantineInfected(
  sessionId: string,
  fileKey: string,
  scanResult: ScanResult,
  session: { userId: string; tenantId: string },
): Promise<void> {
  const uploadService = getUploadService();
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
