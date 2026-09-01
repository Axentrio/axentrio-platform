/**
 * Turn a booking's customer-uploaded files into attachments for the OWNER's
 * booking-notification email, so the owner sees the files inline instead of only
 * a "N files attached — open the platform" pointer.
 *
 * OWNER ONLY. The customer uploaded these; sending them back is noise.
 *
 * CLEAN ONLY. Only a file that finished scanning clean (`status === 'ready'`) is
 * attached. A quarantined / failed / still-scanning file is skipped, never emailed.
 *
 * SIZE CAPPED. Resend rejects the WHOLE message when it is too large, so one
 * oversized file must not take the notification down with it: it is skipped and
 * the body's "open in Axentrio" line stays as the fallback.
 *
 * BEST EFFORT. A booking email is non-fatal by design; one unreadable file must
 * never stop the others or the send. Every failure is logged and skipped.
 */
import { logger } from '../../utils/logger';
import type { EmailAttachment } from '../../automations/email.service';

/** Per-file ceiling. A bigger file stays in the portal. */
const PER_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Whole-email ceiling across all attachments — well under Resend's ~40MB limit. */
const TOTAL_MAX_BYTES = 15 * 1024 * 1024;

/** The upload-store surface this needs — a subset of UploadService, so it is trivially testable. */
export interface UploadedFileStore {
  getSession(id: string): Promise<
    | {
        status: string;
        fileKey: string;
        originalName: string;
        mimeType: string;
        fileSize: number;
        scanResult?: { clean: boolean };
      }
    | undefined
  >;
  getObjectBytes(fileKey: string): Promise<Buffer>;
}

/**
 * Read each ready file and return it as a base64 email attachment. Order follows
 * `fileSessionIds`. Files that are missing, not clean, oversized, or over the
 * running budget are skipped; the result may be shorter than the input (or empty).
 */
export async function buildOwnerFileAttachments(
  fileSessionIds: string[],
  store: UploadedFileStore,
): Promise<EmailAttachment[]> {
  const out: EmailAttachment[] = [];
  let total = 0;
  for (const id of fileSessionIds) {
    try {
      const file = await store.getSession(id);
      // 'ready' is the terminal clean state; anything else is never emailed.
      if (!file || file.status !== 'ready' || file.scanResult?.clean === false) continue;
      if (file.fileSize > PER_FILE_MAX_BYTES) {
        logger.info('[Booking] file too big to attach to owner email; left in portal', {
          id,
          fileSize: file.fileSize,
        });
        continue;
      }
      if (total + file.fileSize > TOTAL_MAX_BYTES) {
        logger.info('[Booking] owner email attachment budget reached; remaining files left in portal', {
          id,
        });
        continue;
      }
      const bytes = await store.getObjectBytes(file.fileKey);
      // Declared size is the pre-download budget. After the read, the larger of
      // declared vs actual wins so a lying declared size cannot blow Resend.
      const size = Math.max(file.fileSize, bytes.length);
      if (bytes.length > PER_FILE_MAX_BYTES) {
        logger.info('[Booking] file too big to attach to owner email; left in portal', {
          id,
          fileSize: bytes.length,
        });
        continue;
      }
      if (total + size > TOTAL_MAX_BYTES) {
        logger.info('[Booking] owner email attachment budget reached; remaining files left in portal', {
          id,
        });
        continue;
      }
      total += size;
      out.push({
        filename: file.originalName,
        content: bytes.toString('base64'),
        ...(file.mimeType ? { contentType: file.mimeType } : {}),
      });
    } catch (err) {
      logger.warn('[Booking] could not attach uploaded file to owner email (non-fatal)', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
