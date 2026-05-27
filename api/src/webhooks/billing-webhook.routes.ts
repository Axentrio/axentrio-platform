/**
 * Billing webhook router — single endpoint for all provider webhooks.
 *
 * `POST /webhooks/billing/:provider`
 *
 * Mounting (in server.ts):
 *   app.use('/api/v1/webhooks/billing',
 *           express.raw({ type: 'application/json' }),
 *           billingWebhookRoutes);
 *
 * The route MUST be registered BEFORE the app-level `express.json()`
 * middleware so the raw Buffer reaches `verifyWebhook` intact for HMAC
 * signature checking. See § Webhook event handling middleware ordering
 * invariant in .scratch/plan-billing.md.
 *
 * Per-request flow (PR9-locked: advisory-lock + SAVEPOINT, plus the
 * existing per-tenant audit trail in billing_events):
 *   1. Provider allowlist check via registry → 404 on miss.
 *   2. `provider.verifyWebhook` → 400 on bad signature.
 *   3. `provider.normalizeWebhookEvent` → 200 on null (ignored event type).
 *   4. `runStripeWebhookIdempotent` opens an outer tx with
 *      pg_try_advisory_xact_lock(hashtext('webhook_event:stripe:' || event_id))
 *      — on lock contention returns HTTP 503 + Retry-After: 5.
 *      — on already-processed row returns HTTP 200 (replay short-circuit).
 *      Otherwise upserts the chatbot_stripe_webhook_events row to 'processing'
 *      and runs the callback inside a SAVEPOINT.
 *   5. The callback resolves the matching tenant_billing_accounts row,
 *      inserts the per-tenant audit row in billing_events (with the
 *      provider-event uniqueness invariant), and dispatches
 *      `handleNormalizedEvent` for state mutation.
 *   6. Callback failure rolls back the SAVEPOINT, marks the
 *      chatbot_stripe_webhook_events row 'failed' with last_error, commits the
 *      outer tx so the status update is durable, and returns HTTP 500
 *      (Stripe retries; next attempt re-enters Step A with attempts++).
 *   7. Callback success marks the row 'processed', commits, returns HTTP 200.
 */

import { Router, Request, Response } from 'express';
import {
  handleNormalizedEvent,
  resolveEventRow,
  runStripeWebhookIdempotent,
} from '../billing/events';
import {
  getBillingProvider,
  isWebhookProvider,
} from '../billing/provider-registry';
import { logger } from '../utils/logger';

// Outcomes from handleNormalizedEvent that represent "applied normally"
// (no extra audit payload needed). Anything outside this set gets a
// payload-merge UPDATE to record the marker for support traceability.
const NORMAL_OUTCOMES = new Set<string>([
  'tier_cascaded',
  'promoted_primary',
  'non_primary_row_updated',
  'past_due_grace',
  'past_due_recovered',
  'marked_past_due',
  'invoice_paid_no_state_change',
  'invoice_payment_failed_no_state_change',
  'audit_only_refund',
]);

export const billingWebhookRoutes = Router();

billingWebhookRoutes.post('/:provider', async (req: Request, res: Response) => {
  const providerName = req.params.provider;

  if (!isWebhookProvider(providerName)) {
    res.status(404).json({ error: 'Unknown billing provider' });
    return;
  }

  const provider = getBillingProvider(providerName);

  // verifyWebhook receives the raw Buffer (express.raw middleware applied
  // to this mount point ahead of any JSON parser).
  let providerEvent: unknown;
  try {
    providerEvent = await provider.verifyWebhook({
      rawBody: req.body as Buffer,
      headers: req.headers as Record<string, string>,
    });
  } catch (err) {
    logger.warn('Billing webhook signature verification failed', {
      provider: providerName,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(400).json({ error: 'Invalid webhook signature' });
    return;
  }

  const normalized = provider.normalizeWebhookEvent(providerEvent);
  if (normalized === null) {
    // Stripe event type we don't care about — ack so it doesn't retry.
    res.status(200).json({ ignored: true });
    return;
  }

  // Resolve the best-known tenantId for the row from the raw event metadata
  // so it can be persisted on the chatbot_stripe_webhook_events row even before the
  // handler resolves it for mutation. NULL is acceptable.
  const rawEventForMeta = normalized.raw as
    | {
        data?: {
          object?: {
            metadata?: { tenantId?: string };
            subscription?: { metadata?: { tenantId?: string } } | string;
            customer?: { metadata?: { tenantId?: string } } | string;
          };
        };
      }
    | undefined;
  const rawObj = rawEventForMeta?.data?.object;
  const metadataTenantId =
    (typeof rawObj?.metadata?.tenantId === 'string' ? rawObj.metadata.tenantId : null) ??
    (rawObj?.subscription && typeof rawObj.subscription === 'object'
      ? rawObj.subscription.metadata?.tenantId ?? null
      : null) ??
    (rawObj?.customer && typeof rawObj.customer === 'object'
      ? rawObj.customer.metadata?.tenantId ?? null
      : null);

  const outcome = await runStripeWebhookIdempotent({
    eventId: normalized.providerEventId,
    eventType: normalized.type,
    payload: normalized.raw as Record<string, unknown>,
    subscriptionId: normalized.subscriptionId ?? null,
    tenantId: metadataTenantId ?? null,
    callback: async (manager) => {
      // Existing per-tenant audit trail (billing_events) + state-mutation
      // dispatch. Runs inside the wrapper's SAVEPOINT so any throw rolls
      // back both the billing_events insert AND the local mutations while
      // the outer wrapper still commits the status='failed' update.
      const matched = await resolveEventRow(manager, normalized);
      const resolvedTenantId = matched?.tenantId ?? null;

      // Idempotency-gated audit insert. The unique index on
      // (provider, provider_event_id) is PARTIAL (WHERE provider_event_id
      // IS NOT NULL) so Postgres requires the same WHERE predicate on
      // ON CONFLICT to use it as the arbiter index. Without the WHERE,
      // the INSERT fails with "no unique or exclusion constraint matching
      // the ON CONFLICT specification" — even though provider_event_id is
      // always non-null at this callsite.
      const inserted: Array<{ id: string }> = await manager.query(
        `INSERT INTO billing_events
           (tenant_id, provider, provider_event_id, event_type, payload, raw_payload)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (provider, provider_event_id) WHERE provider_event_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          resolvedTenantId,
          providerName,
          normalized.providerEventId,
          normalized.type,
          JSON.stringify({
            customerId: normalized.customerId,
            subscriptionId: normalized.subscriptionId ?? null,
            occurredAt: normalized.occurredAt.toISOString(),
            invoiceUrl: normalized.invoiceUrl ?? null,
          }),
          JSON.stringify(normalized.raw),
        ],
      );

      // Note: the new chatbot_stripe_webhook_events row is the canonical idempotency
      // gate (PR9). If billing_events insert returns zero rows it means a
      // previous attempt already wrote the audit but failed to finalize the
      // status row — proceed with the handler dispatch anyway so the state
      // mutation can be applied.

      const handlerOutcome = await handleNormalizedEvent(manager, normalized, matched);

      // Special case: checkout.session.completed unresolved-tenant path —
      // finalize the wrapper's chatbot_stripe_webhook_events row as 'processed' with
      // a last_error message so Stripe doesn't retry, but ops can still
      // surface the failure in event-log queries.
      const finalizeAsProcessedWithError =
        handlerOutcome.outcome === 'checkout_session_unresolved_tenant'
          ? 'cannot resolve tenant from checkout session'
          : undefined;

      // Record the outcome marker on the audit row for support
      // traceability when the outcome is non-standard.
      if (inserted.length > 0 && !NORMAL_OUTCOMES.has(handlerOutcome.outcome)) {
        await manager.query(
          `UPDATE billing_events
             SET payload = payload || $1::jsonb
           WHERE id = $2`,
          [
            JSON.stringify({ outcome: handlerOutcome.outcome, ...(handlerOutcome.meta ?? {}) }),
            inserted[0].id,
          ],
        );
      }

      logger.info('Billing webhook processed', {
        provider: providerName,
        eventType: normalized.type,
        eventId: normalized.providerEventId,
        tenantId: resolvedTenantId,
        outcome: handlerOutcome.outcome,
      });

      return {
        outcome: handlerOutcome.outcome,
        meta: handlerOutcome.meta,
        finalizeAsProcessedWithError,
      };
    },
  });

  switch (outcome.status) {
    case 'lock_unavailable':
      // Parallel worker is mid-processing this event_id. Tell Stripe to
      // back off and retry — next attempt either short-circuits cleanly
      // (status='processed') or re-enters the loop if the locked
      // processor failed.
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'Concurrent processing in progress' });
      return;
    case 'replay':
      res.status(200).json({ alreadyProcessed: true });
      return;
    case 'processed':
      res.status(200).json({ received: true, outcome: outcome.outcome });
      return;
    case 'failed':
      res.status(500).json({ error: 'Webhook processing failed' });
      return;
  }
});
