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
 * Per-request flow (unified DB transaction, codex r4 #1):
 *   1. Provider allowlist check via registry → 404 on miss.
 *   2. `provider.verifyWebhook` → 400 on bad signature.
 *   3. `provider.normalizeWebhookEvent` → 200 on null (ignored event type).
 *   4. Open one DB tx that:
 *      - resolves the tenant via the per-event lookup rules,
 *      - inserts the audit row (with resolved tenant_id or NULL)
 *        ON CONFLICT (provider, provider_event_id) DO NOTHING — rollback
 *        and return 200 if no rows inserted (already processed),
 *      - dispatches to `handleNormalizedEvent` for state mutation,
 *      - commits.
 *   5. Any throw inside the tx rolls everything back so the provider's
 *      next retry succeeds and writes both audit + state.
 */

import { Router, Request, Response } from 'express';
import { runInTransaction } from '../database/data-source';
import { handleNormalizedEvent, resolveEventRow } from '../billing/events';
import {
  getBillingProvider,
  isWebhookProvider,
} from '../billing/provider-registry';
import { logger } from '../utils/logger';

// Internal sentinel used to abort the tx cleanly when ON CONFLICT skipped
// the audit insert (event already processed). Declared at module scope so
// the handler's instanceof check sees it.
class AlreadyProcessedSignal extends Error {
  constructor() {
    super('billing_event_already_processed');
    this.name = 'AlreadyProcessedSignal';
  }
}

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

  try {
    await runInTransaction(async (manager) => {
      // 1. Resolve the matching tenant row (no mutation yet).
      const matched = await resolveEventRow(manager, normalized);
      const resolvedTenantId = matched?.tenantId ?? null;

      // 2. Idempotency-gated audit insert.
      const inserted: Array<{ id: string }> = await manager.query(
        `INSERT INTO billing_events
           (tenant_id, provider, provider_event_id, event_type, payload, raw_payload)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (provider, provider_event_id) DO NOTHING
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

      if (inserted.length === 0) {
        // Already processed — throw the sentinel to rollback (no-op).
        throw new AlreadyProcessedSignal();
      }

      // 3. State mutation — may throw, in which case both audit + state
      // roll back and the provider's retry will succeed.
      const outcome = await handleNormalizedEvent(manager, normalized, matched);

      // Record the outcome marker on the audit row for support
      // traceability when the outcome is non-standard (mismatch, unknown
      // price, no matching row, etc.).
      if (!NORMAL_OUTCOMES.has(outcome.outcome)) {
        await manager.query(
          `UPDATE billing_events
             SET payload = payload || $1::jsonb
           WHERE id = $2`,
          [
            JSON.stringify({ outcome: outcome.outcome, ...(outcome.meta ?? {}) }),
            inserted[0].id,
          ],
        );
      }

      logger.info('Billing webhook processed', {
        provider: providerName,
        eventType: normalized.type,
        eventId: normalized.providerEventId,
        tenantId: resolvedTenantId,
        outcome: outcome.outcome,
      });
    });

    res.status(200).json({ received: true });
  } catch (err) {
    if (err instanceof AlreadyProcessedSignal) {
      res.status(200).json({ alreadyProcessed: true });
      return;
    }
    logger.error('Billing webhook processing failed; provider will retry', {
      provider: providerName,
      eventType: normalized.type,
      eventId: normalized.providerEventId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});
