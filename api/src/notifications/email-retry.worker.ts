/**
 * Retry failed booking emails whose payload was retained.
 *
 * Retrying an old invite after a newer SEQUENCE was delivered is harmless -
 * RFC 5546 clients ignore a lower SEQUENCE for the same UID.
 */
import { AppDataSource } from '../database/data-source';
import type { EmailDeliveryPayload } from '../database/entities/EmailDelivery';
import { emailDeliveryService, type SendDurableResult } from '../services/email-delivery.service';
import { logger } from '../utils/logger';
import { returningRows } from '../utils/raw-sql';

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

/**
 * Push a still-failed row to its next attempt, and answer with its attempt count after the write.
 *
 * `incrementAttempt` is the whole difference between the two failure shapes. A `failed` RESULT
 * means `sendDurable` already committed its own `attempt_count + 1`, so counting it again here
 * would double-count. A throw FROM `sendDurable` means that transaction rolled back, so the row
 * has to advance HERE or it stays permanently due: it would re-fill the oldest claim slot every
 * tick, and CLAIM_LIMIT poison rows would starve every newer invite for good.
 *
 * Clearing `next_attempt_at` at the cap drops the row out of the claim filter for good.
 */
async function advanceAfterFailure(deliveryId: string, incrementAttempt: boolean): Promise<number | null> {
  // UPDATE…RETURNING comes back as `[rows, affectedCount]`, so reading `[0]` raw would answer
  // NaN and the cap diagnostic below would never fire.
  const rows = returningRows<{ attempt_count: number }>(
    await AppDataSource.query(
      `UPDATE email_deliveries
          SET attempt_count = attempt_count + $2::int,
              next_attempt_at = CASE
                WHEN attempt_count + $2::int >= $3::int THEN NULL
                ELSE now() + LEAST(power(2, attempt_count + $2::int), 60) * interval '1 minute'
              END
        WHERE id = $1 AND status = 'failed'
        RETURNING attempt_count`,
      [deliveryId, incrementAttempt ? 1 : 0, MAX_ATTEMPTS],
    ),
  );
  return rows.length ? Number(rows[0].attempt_count) : null;
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
    // A throw must not abort the ordered batch, and the row must not survive the tick still
    // due. The catch below wraps ONLY the send: if the backoff UPDATE were inside it too, a
    // database blip on that UPDATE would look like a thrown send and increment an attempt
    // that sendDurable had already committed.
    let attempts: number | null = null;
    let result: SendDurableResult | null = null;
    try {
      const payload = row.payload;
      result = await emailDeliveryService.sendDurable({
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
    } catch (error) {
      // The class only. A provider or driver message can carry the recipient address or the
      // rendered body, and this log is ids-only by contract.
      logger.warn('[EmailRetry] send threw, advancing it and continuing the batch', {
        deliveryId: row.id,
        tenantId: row.tenant_id,
        kind: row.kind,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      // The send transaction rolled back, so this row's attempt has to be counted here. If the
      // advance itself fails the row stays un-advanced and due, which is worth its own line.
      attempts = await advanceAfterFailure(row.id, true).catch((advanceError: unknown) => {
        logger.warn('[EmailRetry] advance after a thrown send failed, row stays due', {
          deliveryId: row.id,
          tenantId: row.tenant_id,
          kind: row.kind,
          errorName: advanceError instanceof Error ? advanceError.name : 'unknown',
        });
        return null;
      });
    }
    if (result) {
      if (result.status === 'sent' || result.status === 'already_sent') {
        resent += 1;
        continue;
      }
      // A failed RESULT means sendDurable already committed its own attempt_count + 1, so this
      // only moves the clock and must never increment again.
      attempts = await advanceAfterFailure(row.id, false).catch((advanceError: unknown) => {
        // Ids only, same contract as the send log. The row keeps its old due time and retries.
        logger.warn('[EmailRetry] backoff update failed, leaving the row due', {
          deliveryId: row.id,
          tenantId: row.tenant_id,
          kind: row.kind,
          errorName: advanceError instanceof Error ? advanceError.name : 'unknown',
        });
        return null;
      });
    }
    if (attempts !== null && attempts >= MAX_ATTEMPTS) {
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
