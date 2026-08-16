/**
 * Per-message external delivery state (#128).
 *
 * `routeOutboundMessage` records a `MessageDelivery` row and returns success, but
 * it never touched the internal `messages.status`, so the portal composer's
 * FAILED/retry affordance (which keys off `message.status = 'failed'`, reconciled
 * by `clientMessageId`) was only ever reachable for a POST-level failure. These
 * helpers close that gap for the operator reply path: a channel-delivery failure
 * flips the message to `failed` and re-emits it, and a retry that succeeds clears
 * the failure. A retry re-delivers ONLY a message that is currently failed, so an
 * accidental duplicate of a delivered reply can never double-send to the customer.
 */
import { AppDataSource } from '../database/data-source';
import { emitMessageCreatedForSession } from '../realtime/conversation-events';
import { routeOutboundMessage } from './outbound-router';
import { logger } from '../utils/logger';

export interface OperatorReply {
  sessionId: string;
  tenantId: string;
  messageId: string;
  clientMessageId: string;
  content: string;
  createdAt: string | Date;
}

async function emitState(reply: OperatorReply, status: 'sent' | 'failed'): Promise<void> {
  // Reconciled by identity: the composer maps this back to its optimistic bubble
  // via `metadata.clientMessageId` and updates the delivery indicator in place.
  await emitMessageCreatedForSession(reply.sessionId, reply.tenantId, {
    id: reply.messageId,
    sessionId: reply.sessionId,
    type: 'text',
    content: reply.content,
    senderType: 'agent',
    status,
    createdAt: reply.createdAt,
    metadata: { clientMessageId: reply.clientMessageId },
  });
}

/** Flip the message to `failed` and surface it. A failure always needs showing. */
export async function markDeliveryFailed(reply: OperatorReply): Promise<void> {
  await AppDataSource.query(`UPDATE messages SET status = 'failed' WHERE id = $1`, [reply.messageId]);
  await emitState(reply, 'failed');
}

/**
 * Clear a failure that a retry just healed. Only acts on a message we claimed for
 * retry (`sending`), so a first successful send — which is already `sent` — is a
 * no-op and emits nothing.
 */
export async function markDeliverySent(reply: OperatorReply): Promise<void> {
  const rows = (await AppDataSource.query(
    `UPDATE messages SET status = 'sent' WHERE id = $1 AND status = 'sending' RETURNING id`,
    [reply.messageId],
  )) as Array<{ id: string }>;
  if (!Array.isArray(rows) || rows.length === 0) return;
  await emitState(reply, 'sent');
}

/**
 * Win the right to retry a failed message: atomically `failed -> sending`. Returns
 * false when the message is not failed (already delivered, or another retry won),
 * which is what stops a re-POST of a delivered reply from re-sending.
 */
export async function claimFailedForRetry(messageId: string): Promise<boolean> {
  const rows = (await AppDataSource.query(
    `UPDATE messages SET status = 'sending' WHERE id = $1 AND status = 'failed' RETURNING id`,
    [messageId],
  )) as Array<{ id: string }>;
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Deliver an operator reply to the external channel and reconcile its per-message
 * state. Fire-and-forget from the route (never blocks the response); the persisted
 * message is the source of truth and the socket event carries the outcome.
 */
export async function deliverOperatorReply(reply: OperatorReply): Promise<void> {
  try {
    const result = await routeOutboundMessage(
      { type: 'text', content: reply.content },
      { sessionId: reply.sessionId, tenantId: reply.tenantId, messageId: reply.messageId },
      undefined, // WebSocket already emitted by the caller
      { humanAgent: true },
    );
    if (result.success) {
      await markDeliverySent(reply);
    } else {
      logger.warn('[delivery] operator reply rejected by channel', {
        sessionId: reply.sessionId,
        messageId: reply.messageId,
        error: result.error,
      });
      await markDeliveryFailed(reply);
    }
  } catch (err) {
    logger.error('[delivery] operator reply delivery threw', {
      sessionId: reply.sessionId,
      messageId: reply.messageId,
      error: err instanceof Error ? err.message : String(err),
    });
    await markDeliveryFailed(reply).catch(() => undefined);
  }
}
