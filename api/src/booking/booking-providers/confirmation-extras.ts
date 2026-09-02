/**
 * The global extras an owner attaches to EVERY customer booking-confirmation email for one
 * Agent: an information text and a list of files.
 *
 * CUSTOMER ONLY. The owner wrote these for the customer; putting them on the owner's own
 * notification would mail the owner their own parking instructions on every booking.
 *
 * CONFIRMATIONS ONLY. `sendBookingEmail` calls this for a `REQUEST`, so a create, an
 * owner-accepted request, a reschedule and an invite re-issue all carry the extras, and a
 * cancellation and a reminder never do.
 *
 * BEST EFFORT. A booking email is non-fatal by design. One unreadable PDF must never stop
 * the confirmation: every read failure is logged and skipped, and the text still goes.
 *
 * SIZE CAPPED. Resend rejects the WHOLE message when it is too large, so one oversized file
 * must not take the confirmation down with it. The per-file ceiling is the SAME number the
 * upload route enforces, so a file that was accepted can never be silently dropped here.
 */
import { AppDataSource } from '../../database/data-source';
import { BookingSettings } from '../../database/entities/BookingSettings';
import { config } from '../../config/environment';
import { logger } from '../../utils/logger';
import type { EmailAttachment } from '../../automations/email.service';
import { getUploadService } from '../../file-handling/upload.service';
import { TOTAL_MAX_BYTES } from './booking-attachments';

/** Per-file ceiling in bytes. Platform-configurable; the upload route gates on the same value. */
export const confirmationAttachmentMaxBytes = (): number =>
  Math.max(1, config.booking.confirmationAttachmentMaxMb) * 1024 * 1024;

/** The mime types an owner may attach to a confirmation email, checked against DETECTED bytes. */
export const CONFIRMATION_ATTACHMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
];

export interface ConfirmationExtras {
  /** The owner's own words. Never translated, never rewritten by a model. */
  text?: string;
  attachments: EmailAttachment[];
}

/** The store surface this needs — a subset of UploadService, so it is trivially testable. */
export interface ConfirmationFileStore {
  getObjectBytes(fileKey: string): Promise<Buffer>;
}

interface StoredAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileKey: string;
  uploadedAt: string;
}

/**
 * Read one Agent's confirmation extras, with every attachment already base64-encoded.
 *
 * Returns `null` when the Agent has neither a text nor a readable file — the state every
 * Agent starts in, and the one where the confirmation email is byte-identical to before
 * this feature existed.
 */
export async function loadConfirmationExtras(
  botId: string,
  store?: ConfirmationFileStore,
): Promise<ConfirmationExtras | null> {
  const row = await AppDataSource.getRepository(BookingSettings).findOne({ where: { botId } });
  if (!row) return null;

  const text = row.confirmationExtraInfo?.trim() || undefined;
  const stored: StoredAttachment[] = Array.isArray(row.confirmationAttachments)
    ? (row.confirmationAttachments as StoredAttachment[])
    : [];

  const attachments = stored.length ? await readAttachments(botId, stored, store) : [];
  if (!text && !attachments.length) return null;
  return { ...(text ? { text } : {}), attachments };
}

async function readAttachments(
  botId: string,
  stored: StoredAttachment[],
  store?: ConfirmationFileStore,
): Promise<EmailAttachment[]> {
  const perFileMax = confirmationAttachmentMaxBytes();
  const reader = store ?? getUploadService();
  const out: EmailAttachment[] = [];
  let total = 0;

  for (const file of stored) {
    if (!file?.fileKey || typeof file.fileKey !== 'string') continue;
    if (typeof file.fileSize === 'number' && file.fileSize > perFileMax) {
      logger.warn('[Booking] confirmation attachment over the per-file cap, skipped', {
        botId,
        fileName: file.fileName,
        fileSize: file.fileSize,
      });
      continue;
    }
    try {
      const bytes = await reader.getObjectBytes(file.fileKey);
      // Checked against the REAL length, not the stored one: a row can lie, S3 cannot.
      if (bytes.length > perFileMax) {
        logger.warn('[Booking] confirmation attachment over the per-file cap, skipped', {
          botId,
          fileName: file.fileName,
          fileSize: bytes.length,
        });
        continue;
      }
      if (total + bytes.length > TOTAL_MAX_BYTES) {
        logger.warn('[Booking] confirmation attachment over the total email budget, skipped', {
          botId,
          fileName: file.fileName,
        });
        continue;
      }
      total += bytes.length;
      out.push({
        filename: file.fileName || 'attachment',
        content: bytes.toString('base64'),
        contentType: file.mimeType || 'application/octet-stream',
      });
    } catch (err) {
      logger.warn('[Booking] could not read a confirmation attachment (non-fatal)', {
        botId,
        fileName: file.fileName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
