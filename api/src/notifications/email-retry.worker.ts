/**
 * Retry failed booking emails whose payload was retained.
 *
 * Retrying an old invite after a newer SEQUENCE was delivered is harmless -
 * RFC 5546 clients ignore a lower SEQUENCE for the same UID.
 */
import { AppDataSource } from '../database/data-source';
import type { EmailDeliveryPayload } from '../database/entities/EmailDelivery';
import { emailDeliveryService } from '../services/email-delivery.service';
import { logger } from '../utils/logger';

const CLAIM_LIMIT = 20;
const MAX_ATTEMPTS = 6;

interface ClaimedRow {
  id: string;
  tenant_id: string;
  recipient_email: string;
  subject: string;
  kind: string;
  related_id: string;
  idempotency_key: string;
  attempt_count: number;
  payload: EmailDeliveryPayload;
}

let inFlight = false;

export async function sweepFailedEmailDeliveries(): Promise<{ resent: number; gaveUp: number }> {
  if (inFlight) return { resent: 0, gaveUp: 0 };
  inFlight = true;
  try {
    return await runSweep();
  } finally {
    inFlight = false;
  }
}

async function runSweep(): Promise<{ resent: number; gaveUp: number }> {
  const rows = (await AppDataSource.query(
    `SELECT id, tenant_id, recipient_email, subject, kind, related_id, idempotency_key, attempt_count, payload
       FROM email_deliveries
      WHERE status = 'failed'
        AND payload IS NOT NULL
        AND attempt_count < $1
        AND next_attempt_at IS NOT NULL
        AND next_attempt_at <= now()
      ORDER BY created_at ASC
      LIMIT $2`,
    [MAX_ATTEMPTS, CLAIM_LIMIT],
  )) as ClaimedRow[];

  let resent = 0;
  let gaveUp = 0;
  for (const row of rows) {
    // One poison row must not abort the ordered batch. An unhandled throw here
    // would starve every newer failed invite on each 60s tick.
    try {
      const payload = row.payload;
      const result = await emailDeliveryService.sendDurable({
        tenantId: row.tenant_id,
        recipientEmail: row.recipient_email,
        subject: payload.subject,
        body: payload.body,
        from: payload.from,
        replyTo: payload.replyTo,
        attachments: payload.attachments,
        kind: row.kind,
        relatedId: row.related_id,
        idempotencyKey: row.idempotency_key,
        retainPayload: true,
      });
      if (result.status === 'sent' || result.status === 'already_sent') {
        resent += 1;
        continue;
      }
      await AppDataSource.query(
        `UPDATE email_deliveries
            SET next_attempt_at = now() + LEAST(power(2, attempt_count), 60) * interval '1 minute'
          WHERE id = $1 AND status = 'failed'`,
        [row.id],
      );
      if (result.status === 'failed') {
        const attempts = Number(row.attempt_count) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          gaveUp += 1;
          // Diagnostics, not an alert, and DUPLICATES ARE POSSIBLE: the claim holds no
          // cross-process lease, so two replicas can both report the same row. Ids only -
          // never the recipient address and never the body.
          logger.warn('[EmailRetry] gave up on a booking email', {
            deliveryId: row.id,
            tenantId: row.tenant_id,
            kind: row.kind,
            attemptCount: attempts,
          });
        }
      }
    } catch (error) {
      logger.warn('[EmailRetry] row failed, continuing the batch', {
        deliveryId: row.id,
        tenantId: row.tenant_id,
        kind: row.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (resent > 0 || gaveUp > 0) {
    logger.info('[EmailRetry] sweep', { resent, gaveUp });
  }
  return { resent, gaveUp };
}

export function startEmailRetryWorker(): NodeJS.Timeout {
  return setInterval(() => {
    void sweepFailedEmailDeliveries().catch((error) => {
      logger.error('[EmailRetry] sweep failed', { error });
    });
  }, 60_000);
}
