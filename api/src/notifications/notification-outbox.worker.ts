/**
 * Handoff-notification outbox worker (ADR-0018).
 *
 * `requestHandoff` writes one `notification_outbox` row INSIDE the handoff
 * transaction. Two things then drain it:
 *
 *  - `deliverHandoffNotification` — the immediate, best-effort dispatch the
 *    handoff call sites run post-commit for low latency. On success it retires
 *    the row so the worker never touches the happy path. Never throws on a
 *    delivery failure (mirrors the old fire-and-forget notify); it only
 *    propagates if it could not even attempt (e.g. the DB is down), which
 *    leaves the row for the worker.
 *  - `sweepHandoffOutbox` — the backstop. It claims rows the immediate path did
 *    not retire (a crash between commit and dispatch) and replays the notify.
 *
 * Safety rests on `notifyNewHandoff` being idempotent (per-recipient
 * notification dedupe + per-recipient email idempotency key), so a row dispatched
 * twice never double-sends. Concurrency mirrors the shipped sweeps: an in-flight
 * guard against overlap in this process, and `FOR UPDATE SKIP LOCKED` so two
 * instances claim disjoint rows. The attempt is counted and `next_attempt_at`
 * pushed out ON CLAIM, so a crash mid-dispatch simply becomes the next retry.
 */
import { AppDataSource } from '../database/data-source';
import {
  NotificationOutbox,
  type HandoffOutboxPayload,
} from '../database/entities/NotificationOutbox';
import { HandoffReason } from '../database/entities/HandoffRequest';
import {
  notifyNewHandoff,
  type NewHandoffNotificationParams,
} from '../services/handoff-notification.service';
import { logger } from '../utils/logger';

const CLAIM_BATCH = 50;
const MAX_BATCHES = 10;
/** Dispatches attempted before a row is parked as `dead`. */
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

function toParams(payload: HandoffOutboxPayload): NewHandoffNotificationParams {
  return {
    tenantId: payload.tenantId,
    handoffId: payload.handoffId,
    sessionId: payload.sessionId,
    // Serialized from a HandoffReason on the way in; restore the nominal type.
    reason: payload.reason as HandoffReason,
    requestedAt: new Date(payload.requestedAt),
  };
}

/** Retire the outbox row for a handoff. Idempotent; only touches a still-pending row. */
async function markDispatched(handoffId: string): Promise<void> {
  await AppDataSource.getRepository(NotificationOutbox).update(
    { kind: 'handoff', relatedId: handoffId, status: 'pending' },
    { status: 'sent', lastError: null },
  );
}

/**
 * Immediate best-effort dispatch for the handoff call sites: run the notify,
 * then retire the outbox row. Throws only if the notify could not be attempted
 * (leaving the row for the worker); a per-channel delivery failure is the
 * `EmailDelivery` ledger's concern, not a reason to keep the outbox row open.
 */
export async function deliverHandoffNotification(
  params: NewHandoffNotificationParams,
): Promise<void> {
  await notifyNewHandoff(params);
  await markDispatched(params.handoffId);
}

let inFlight = false;

/**
 * One sweep tick. Returns how many rows it dispatched and how many it parked as
 * dead. No-ops when a tick is already running in this process.
 */
export async function sweepHandoffOutbox(): Promise<{ dispatched: number; dead: number }> {
  if (inFlight) return { dispatched: 0, dead: 0 };
  inFlight = true;
  try {
    return await runSweep();
  } finally {
    inFlight = false;
  }
}

interface ClaimedRow {
  id: string;
  payload: HandoffOutboxPayload;
  attemptCount: number;
}

async function runSweep(): Promise<{ dispatched: number; dead: number }> {
  const repo = AppDataSource.getRepository(NotificationOutbox);
  let dispatched = 0;
  let dead = 0;
  let batches = 0;
  let claimedCount: number;

  do {
    const claimed: ClaimedRow[] = await AppDataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        `SELECT id, payload, attempt_count
           FROM notification_outbox
          WHERE status = 'pending' AND next_attempt_at <= now()
          ORDER BY created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [CLAIM_BATCH],
      )) as Array<{ id: string; payload: HandoffOutboxPayload; attempt_count: number }>;

      const out: ClaimedRow[] = [];
      for (const r of rows) {
        const attempt = Number(r.attempt_count) + 1;
        await manager.query(
          `UPDATE notification_outbox
              SET attempt_count = $2,
                  next_attempt_at = now() + ($3::int * interval '1 millisecond'),
                  updated_at = now()
            WHERE id = $1`,
          [r.id, attempt, backoffMs(attempt)],
        );
        out.push({ id: r.id, payload: r.payload, attemptCount: attempt });
      }
      return out;
    });
    claimedCount = claimed.length;

    for (const row of claimed) {
      try {
        await notifyNewHandoff(toParams(row.payload));
        await repo.update({ id: row.id }, { status: 'sent', lastError: null });
        dispatched += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (row.attemptCount >= MAX_ATTEMPTS) {
          await repo.update({ id: row.id }, { status: 'dead', lastError: message });
          dead += 1;
          logger.error('[outbox] handoff notification gave up after cap', {
            id: row.id,
            attempts: row.attemptCount,
            error: message,
          });
        } else {
          // Stays pending; next_attempt_at was already pushed out on claim.
          await repo.update({ id: row.id }, { lastError: message });
          logger.warn('[outbox] handoff notification dispatch failed; will retry', {
            id: row.id,
            attempt: row.attemptCount,
            error: message,
          });
        }
      }
    }
    batches += 1;
  } while (claimedCount === CLAIM_BATCH && batches < MAX_BATCHES);

  if (dispatched > 0 || dead > 0) {
    logger.info('[outbox] handoff notification sweep', { dispatched, dead });
  }
  return { dispatched, dead };
}
