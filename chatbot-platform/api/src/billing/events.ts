/**
 * Webhook event handler — applies normalized provider events to local state.
 *
 * Runs inside the unified webhook DB transaction (per § Webhook event
 * handling in .scratch/plan-billing.md):
 *   1. The handler (caller) opens a tx and inserts the billing_events
 *      audit row with the *resolved* tenant_id (or null if unresolvable).
 *   2. The handler dispatches to `handleNormalizedEvent` which:
 *      - locks all of the tenant's tenant_billing_accounts rows,
 *      - applies the per-event-type mutation,
 *      - returns,
 *   3. The handler commits, or rolls everything back on throw.
 *
 * Lookup rules (codex r3 #4 / r3 #18 / r4 #2):
 *   - subscription.created: try (provider, subscription_id); fall back to
 *     (provider, customer_id).
 *   - subscription.updated / .deleted: try (provider, subscription_id);
 *     fall back to (provider, customer_id) ONLY when the Stripe row's
 *     subscription_id is still NULL (handles webhook reordering).
 *   - invoice.* / refund.recorded: try (provider, subscriptionId from
 *     normalized event); fall back to (provider, customer_id).
 *
 * Tier-cascade & primary-switch (§ Primary-switch & tier-cascade rules):
 *   - Promotion to is_primary + Tenant.tier mutation fires ONLY when local
 *     status transitions into 'trialing' or 'active'.
 *   - Subsequent cascades require the row to already be is_primary.
 *   - Terminal status on a non-primary row updates row-local fields only.
 */

import { EntityManager } from 'typeorm';
import { logger } from '../utils/logger';
import { Tenant, TenantTier } from '../database/entities/Tenant';
import { TenantBillingAccount } from '../database/entities/TenantBillingAccount';
import { planIdForStripePriceId } from './plans';
import { getStripeClient } from './providers/stripe';
import { InternalPlanId, NormalizedEvent } from './types';

interface ResolvedRow {
  row: TenantBillingAccount;
  tenantId: string;
}

/**
 * Resolve the matching `tenant_billing_accounts` row for an inbound
 * normalized event using the per-event-type lookup rules above. Returns
 * `null` if no row matches — caller writes the audit row with NULL
 * tenant_id and skips mutation.
 *
 * Runs against the tx manager so the matched row is locked when fetched
 * by the caller's subsequent `SELECT … FOR UPDATE`.
 */
export async function resolveEventRow(
  manager: EntityManager,
  event: NormalizedEvent,
): Promise<ResolvedRow | null> {
  const repo = manager.getRepository(TenantBillingAccount);

  // Try by (provider, subscription_id) first when the event carries one.
  if (event.subscriptionId) {
    const bySubId = await repo.findOne({
      where: { provider: 'stripe', subscriptionId: event.subscriptionId },
    });
    if (bySubId) return { row: bySubId, tenantId: bySubId.tenantId };
  }

  // Fallback by (provider, customer_id):
  //  - allowed for `subscription.created` and invoice/refund events
  //    unconditionally,
  //  - allowed for `subscription.updated`/`.deleted` ONLY when the matched
  //    Stripe row's subscription_id is still NULL (webhook reordering).
  if (event.customerId) {
    const byCustomerId = await repo.findOne({
      where: { provider: 'stripe', customerId: event.customerId },
    });
    if (byCustomerId) {
      if (event.type === 'subscription.created') {
        return { row: byCustomerId, tenantId: byCustomerId.tenantId };
      }
      if (event.type === 'subscription.updated' || event.type === 'subscription.deleted') {
        if (byCustomerId.subscriptionId === null) {
          return { row: byCustomerId, tenantId: byCustomerId.tenantId };
        }
        // Subscription mismatch — incoming event is for a different sub.
        // Audit-only handling lives in caller via the audit row.
        return null;
      }
      // invoice/refund — always allowed
      return { row: byCustomerId, tenantId: byCustomerId.tenantId };
    }
  }

  return null;
}

/**
 * Promote `targetRow` to `is_primary=true` and demote any other row for
 * the same tenant — in a SINGLE UPDATE statement so the partial unique
 * index on `(tenant_id) WHERE is_primary` is never violated mid-tx
 * (codex r5 #8). Then set `Tenant.tier` to the row's `current_plan_id`.
 */
async function promotePrimaryAndCascadeTier(
  manager: EntityManager,
  targetRow: TenantBillingAccount,
  newTier: TenantTier,
): Promise<void> {
  await manager.query(
    `UPDATE tenant_billing_accounts
        SET is_primary = CASE
          WHEN id = $1 THEN true
          WHEN tenant_id = $2 AND is_primary = true AND id <> $1 THEN false
          ELSE is_primary
        END
      WHERE tenant_id = $2
        AND (id = $1 OR is_primary = true)`,
    [targetRow.id, targetRow.tenantId],
  );
  await manager.update(Tenant, { id: targetRow.tenantId }, { tier: newTier });
}

/**
 * Apply a normalized event's state mutation to local DB. Caller is
 * responsible for locking the tenant's rows before invoking.
 *
 * Returns an opaque outcome marker the caller logs for telemetry.
 */
export async function handleNormalizedEvent(
  manager: EntityManager,
  event: NormalizedEvent,
  matched: ResolvedRow | null,
): Promise<{ outcome: string; meta?: Record<string, unknown> }> {
  // Refunds, unresolved rows, and audit-only paths short-circuit.
  if (event.type === 'refund.recorded') {
    return { outcome: 'audit_only_refund' };
  }
  if (!matched) {
    return { outcome: 'no_matching_row' };
  }

  const { tenantId } = matched;

  // Lock all of this tenant's billing rows for the remainder of the tx
  // (codex r5 #8 single-statement primary-switch SQL depends on this lock).
  await manager
    .createQueryBuilder()
    .select()
    .from(TenantBillingAccount, 'tba')
    .where('tba.tenant_id = :tenantId', { tenantId })
    .setLock('pessimistic_write')
    .getMany();

  // Re-read the matched row UNDER the lock — the resolveEventRow result is
  // pre-lock and may be stale by the time we hold the lock. All mismatch /
  // status / primary decisions below must use this fresh copy (cluster-2
  // round-1 #2).
  const row = await manager.getRepository(TenantBillingAccount).findOneOrFail({
    where: { id: matched.row.id },
  });

  switch (event.type) {
    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.deleted': {
      if (!event.subscription) {
        return { outcome: 'subscription_event_no_payload' };
      }
      const s = event.subscription;

      // Detect subscription mismatch (codex r4 #16): the row already has a
      // DIFFERENT subscription_id than the incoming event's. Audit-only.
      if (
        row.subscriptionId &&
        s.subscriptionId &&
        row.subscriptionId !== s.subscriptionId
      ) {
        return {
          outcome: 'subscription_mismatch',
          meta: { existing: row.subscriptionId, incoming: s.subscriptionId },
        };
      }

      // Unknown price (codex r4 #15 + cluster-2 round-1 #4): if the raw
      // Stripe price id is unknown to our PLANS catalog, we cannot trust
      // any state transition that would set `current_plan_id`. Apply the
      // guard for ALL non-terminal statuses (trialing/active/past_due AND
      // 'none' from `incomplete` — which is pre-payment, not terminal).
      const rawSub = (event.raw as { data?: { object?: { status?: string; items?: { data?: Array<{ price?: { id?: string } }> } } } })?.data?.object;
      const rawStripeStatus = rawSub?.status;
      const rawPriceId = rawSub?.items?.data?.[0]?.price?.id;
      const isTerminalStripeStatus =
        rawStripeStatus === 'canceled' ||
        rawStripeStatus === 'incomplete_expired' ||
        rawStripeStatus === 'unpaid';
      if (!isTerminalStripeStatus && rawPriceId && planIdForStripePriceId(rawPriceId) === null) {
        return { outcome: 'unknown_price', meta: { priceId: rawPriceId } };
      }

      // past_due preserves plan + tier (grace period, cluster-2 round-1 #1).
      // A failed-but-already-committed Stripe upgrade could otherwise grant
      // the higher tier during grace. We update local status and other
      // metadata, but NOT current_plan_id, and we do not cascade tier.
      const isPastDue = s.status === 'past_due';

      // Plan-id resolution for non-past_due statuses.
      const newPlanForStatus: InternalPlanId = (() => {
        if (isPastDue) return row.currentPlanId; // preserved (unused for past_due update)
        if (s.status === 'none' && rawPriceId) {
          // `incomplete` exception: keep price-mapped plan
          return planIdForStripePriceId(rawPriceId) ?? 'free';
        }
        if (s.status === 'cancelled' || s.status === 'none') return 'free';
        return s.currentPlanId;
      })();

      // Schedule field handling (cluster-2 round-1 #3). Stripe may send the
      // schedule as a full object OR as a string id. When it's a string,
      // retrieve the schedule with expanded phase prices so we can resolve
      // pendingPlanId. When schedule is absent, clear local pending fields.
      const rawSchedule = (event.raw as { data?: { object?: { schedule?: unknown } } })
        ?.data?.object?.schedule;
      let scheduleEnrichment:
        | { pendingPlanId: InternalPlanId | null; pendingPlanEffectiveAt: Date | null; scheduleIdToStore: string | null; clearSchedule: false }
        | { clearSchedule: true }
        | null = null;
      if (typeof rawSchedule === 'string' && rawSchedule.length > 0) {
        // String id — retrieve to get phases. We deliberately do NOT
        // swallow failures here: a transient Stripe API error must bubble
        // up so the whole webhook tx rolls back, letting Stripe retry
        // delivery (and giving us a clean shot at writing the scheduleId).
        const schedule = await getStripeClient().subscriptionSchedules.retrieve(
          rawSchedule,
          { expand: ['phases.items.price'] },
        );
        const phase2 = schedule.phases[1];
        let pendingPlanId: InternalPlanId | null = null;
        let pendingPlanEffectiveAt: Date | null = null;
        if (phase2) {
          const item = phase2.items[0];
          const priceId =
            typeof item?.price === 'string'
              ? item.price
              : (item?.price as { id?: string } | undefined)?.id ?? null;
          pendingPlanId = planIdForStripePriceId(priceId);
          pendingPlanEffectiveAt = phase2.start_date
            ? new Date(phase2.start_date * 1000)
            : null;
        }
        scheduleEnrichment = {
          pendingPlanId,
          pendingPlanEffectiveAt,
          scheduleIdToStore: schedule.id,
          clearSchedule: false,
        };
      } else if (rawSchedule === null || rawSchedule === undefined) {
        // Schedule cleared — null out local pending fields.
        scheduleEnrichment = { clearSchedule: true };
      } else if (typeof rawSchedule === 'object') {
        // Already an expanded object — normalized.pendingPlanId is authoritative.
        scheduleEnrichment = {
          pendingPlanId: s.pendingPlanId,
          pendingPlanEffectiveAt: s.pendingPlanEffectiveAt,
          scheduleIdToStore: (rawSchedule as { id?: string }).id ?? null,
          clearSchedule: false,
        };
      }

      // Persist subscription_id FIRST (codex r3 #4) so subsequent events
      // can lookup by (provider, subscription_id) cleanly.
      // For past_due: skip current_plan_id update.
      // Type as a plain object rather than Partial<entity> to avoid
      // TypeORM's QueryDeepPartialEntity recursing through the relation graph.
      const updateFields: {
        subscriptionId: string | null;
        status: typeof s.status;
        currentPeriodEnd: Date | null;
        cancelAtPeriodEnd: boolean;
        trialEnd: Date | null;
        currentPlanId?: InternalPlanId;
        pendingPlanId?: InternalPlanId | null;
        pendingPlanEffectiveAt?: Date | null;
      } = {
        subscriptionId: s.subscriptionId ?? row.subscriptionId ?? null,
        status: s.status,
        currentPeriodEnd: s.currentPeriodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        trialEnd: s.trialEnd,
      };
      if (!isPastDue) {
        updateFields.currentPlanId = newPlanForStatus;
      }
      if (scheduleEnrichment) {
        if (scheduleEnrichment.clearSchedule) {
          updateFields.pendingPlanId = null;
          updateFields.pendingPlanEffectiveAt = null;
        } else {
          updateFields.pendingPlanId = scheduleEnrichment.pendingPlanId;
          updateFields.pendingPlanEffectiveAt = scheduleEnrichment.pendingPlanEffectiveAt;
        }
      }

      await manager.update(TenantBillingAccount, { id: row.id }, updateFields);

      // Merge raw_provider_data.stripe.scheduleId via jsonb_set (preserves
      // siblings). Or clear it if schedule was removed.
      if (scheduleEnrichment) {
        if (scheduleEnrichment.clearSchedule) {
          await manager.query(
            `UPDATE tenant_billing_accounts
                SET raw_provider_data = raw_provider_data #- '{stripe,scheduleId}'
              WHERE id = $1`,
            [row.id],
          );
        } else if (scheduleEnrichment.scheduleIdToStore) {
          // `jsonb_set` with create_missing=true creates missing LEAF keys
          // but NOT intermediate objects, so the path '{stripe,scheduleId}'
          // is a no-op when `raw_provider_data` is `{}`. Use top-level
          // `||` merge instead, building the nested `stripe` object
          // explicitly and preserving any sibling keys already inside it.
          await manager.query(
            `UPDATE tenant_billing_accounts
                SET raw_provider_data = raw_provider_data || jsonb_build_object(
                  'stripe',
                  COALESCE(raw_provider_data->'stripe', '{}'::jsonb)
                    || jsonb_build_object('scheduleId', $1::text)
                )
              WHERE id = $2`,
            [scheduleEnrichment.scheduleIdToStore, row.id],
          );
        }
      }

      // Primary-switch & tier-cascade rules:
      // - Promotion fires only on transition into 'trialing' or 'active'.
      // - past_due preserves tier (cluster-2 round-1 #1).
      // - Already-primary cascades tier for trialing/active/cancelled/none.
      const isPromotion = (s.status === 'trialing' || s.status === 'active') && !row.isPrimary;
      if (isPromotion) {
        await promotePrimaryAndCascadeTier(manager, row, newPlanForStatus);
        return { outcome: 'promoted_primary' };
      }

      if (row.isPrimary && !isPastDue) {
        await manager.update(Tenant, { id: tenantId }, { tier: newPlanForStatus });
        return { outcome: 'tier_cascaded' };
      }

      if (row.isPrimary && isPastDue) {
        // Grace period — tier preserved.
        return { outcome: 'past_due_grace' };
      }

      // Non-primary row: update row-local fields only.
      return { outcome: 'non_primary_row_updated' };
    }

    case 'invoice.paid': {
      // Recovery from past_due: if row was past_due, move back to active.
      if (row.status === 'past_due') {
        await manager.update(
          TenantBillingAccount,
          { id: row.id },
          { status: 'active' },
        );
        // tier was preserved through past_due, so no cascade needed
        return { outcome: 'past_due_recovered' };
      }
      return { outcome: 'invoice_paid_no_state_change' };
    }

    case 'invoice.payment_failed': {
      // Move to past_due if not already terminal.
      if (row.status === 'active' || row.status === 'trialing') {
        await manager.update(
          TenantBillingAccount,
          { id: row.id },
          { status: 'past_due' },
        );
        // tier unchanged (grace period)
        return { outcome: 'marked_past_due' };
      }
      return { outcome: 'invoice_payment_failed_no_state_change' };
    }

    default: {
      logger.warn('Unknown normalized event type', { type: event.type });
      return { outcome: 'unknown_event_type' };
    }
  }
}
