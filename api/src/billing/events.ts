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
import Stripe from 'stripe';
import { logger } from '../utils/logger';
import { returningRows } from '../utils/raw-sql';
import { AppDataSource } from '../database/data-source';
import { Tenant, TenantTier } from '../database/entities/Tenant';
import { TenantBillingAccount } from '../database/entities/TenantBillingAccount';
import { planIdForStripePriceId } from './plans';
import { getStripeClient } from './providers/stripe';
import { invalidateEntitlementsAndModules } from '../modules';
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
  // NB: entitlement/module cache invalidation is deferred to AFTER the outer
  // commit (the caller surfaces this tenant via invalidateTenantIds) — never
  // here inside the open tx, where a concurrent miss would re-cache the old tier.
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
): Promise<{ outcome: string; meta?: Record<string, unknown>; invalidateTenantIds?: string[] }> {
  // Refunds, unresolved rows, and audit-only paths short-circuit.
  if (event.type === 'refund.recorded') {
    return { outcome: 'audit_only_refund' };
  }

  // PR9: trial_will_end is logging-only and intentionally has NO state
  // mutation, no email, no banner. Just emit the structured log line; the
  // idempotency wrapper persists the event-log row.
  if (event.type === 'subscription.trial_will_end') {
    const raw = event.raw as {
      data?: { object?: { trial_end?: number | null } };
    };
    const trialEnd = raw?.data?.object?.trial_end
      ? new Date(raw.data.object.trial_end * 1000).toISOString()
      : null;
    logger.info('Stripe trial_will_end received', {
      eventId: event.providerEventId,
      subscriptionId: event.subscriptionId ?? null,
      tenantId: matched?.tenantId ?? null,
      trialEnd,
    });
    return { outcome: 'trial_will_end_logged' };
  }

  // PR9: checkout.session.completed is bookkeeping only — persists
  // customer_id / subscription_id onto the TBA row. Tier change is driven
  // by the subsequent customer.subscription.created event.
  if (event.type === 'checkout.session.completed') {
    return handleCheckoutSessionCompleted(manager, event);
  }

  // Audit gap #2 fix: release the trial reservation for an abandoned
  // checkout so the tenant can retry with a fresh trial (M0 line 532).
  // Scoped by (tenant_id, checkout_session_id, subscription_id IS NULL)
  // so a stale expired event can't delete a newer pending reservation
  // and a claimed row stays put.
  if (event.type === 'checkout.session.expired') {
    return handleCheckoutSessionExpired(manager, event);
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
    case 'subscription.deleted': {
      // PR9: dedicated cancellation sink with stale-guard + resource_missing
      // refetch distinction. Earlier behavior (sharing the created/updated
      // arm) didn't apply the stale guard and silently called the schedule
      // retrieve path on cancelled subs.
      const deletedSubId = (event.raw as { data?: { object?: { id?: string } } })
        ?.data?.object?.id;

      // Stale-subscription guard (codex round 6 item 4): if the TBA row no
      // longer points at the deleted subscription, an OLDER cancellation
      // event arrived after the tenant re-subscribed. Do not clobber the
      // newer state.
      if (deletedSubId && row.subscriptionId && row.subscriptionId !== deletedSubId) {
        logger.info(
          'Stale subscription.deleted event; current TBA points at a different subscription — no mutation',
          {
            eventId: event.providerEventId,
            tenantId,
            deletedSubId,
            currentSubscriptionId: row.subscriptionId,
          },
        );
        return {
          outcome: 'subscription_deleted_stale',
          meta: { deletedSubId, currentSubscriptionId: row.subscriptionId },
        };
      }

      // Refetch with resource_missing distinction (codex round 6 item 5).
      // Stripe keeps cancelled subs visible for a while; a successful refetch
      // confirms the deletion is current canonical state. A resource_missing
      // error means Stripe hard-deleted the record — payload is canonical,
      // proceed. Any other error means transient API failure — re-throw so
      // the wrapper marks failed and Stripe retries.
      let refetchOutcome: 'fresh' | 'resource_missing_proceed' = 'fresh';
      if (deletedSubId) {
        try {
          await getStripeClient().subscriptions.retrieve(deletedSubId);
        } catch (err) {
          if (
            err instanceof Stripe.errors.StripeInvalidRequestError &&
            err.code === 'resource_missing'
          ) {
            refetchOutcome = 'resource_missing_proceed';
            logger.warn(
              'subscription.deleted refetch returned resource_missing — proceeding with cancellation',
              { eventId: event.providerEventId, deletedSubId },
            );
          } else {
            logger.warn(
              'subscription.deleted refetch failed with non-resource_missing error — Stripe will retry',
              {
                eventId: event.providerEventId,
                deletedSubId,
                error: err instanceof Error ? err.message : String(err),
              },
            );
            throw err;
          }
        }
      }

      // Apply cancellation mutations (plan PR9 §"customer.subscription.deleted").
      await manager.update(
        TenantBillingAccount,
        { id: row.id },
        {
          status: 'cancelled',
          currentPlanId: 'free',
          pendingPlanId: null,
          pendingPlanEffectiveAt: null,
          trialEnd: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          subscriptionId: null,
        },
      );
      // Primary cancellation cascades Tenant.tier='free'. Non-primary rows
      // stay row-local — Tenant.tier reflects the surviving primary.
      if (row.isPrimary) {
        await manager.update(Tenant, { id: tenantId }, { tier: 'free' });
        // Invalidation deferred to after the outer commit (see return below).
      }

      // Audit log entry — `tenant.cancelled`. actor_id is the Tenant.id
      // (Stripe is not a User; AuditLog.actorId is NOT NULL so we record the
      // Tenant as both actor and entity to preserve the foreign-key shape).
      const auditMeta: Record<string, unknown> = {
        eventId: event.providerEventId,
        deletedSubId,
        refetchOutcome,
      };
      if (refetchOutcome === 'resource_missing_proceed') {
        auditMeta.refetch_failed = 'resource_missing';
      }
      // Use raw SQL — TypeORM's insert() narrows `metadata` against the
      // entity's `Record<string, unknown> | undefined` field in a way that
      // rejects a dynamic dictionary literal.
      await manager.query(
        `INSERT INTO audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          tenantId,
          tenantId,
          'tenant.cancelled',
          'tenant',
          tenantId,
          JSON.stringify(auditMeta),
        ],
      );

      return {
        outcome: 'tenant_cancelled',
        meta: auditMeta,
        // Only a primary cancellation cascaded Tenant.tier → 'free'.
        invalidateTenantIds: row.isPrimary ? [tenantId] : undefined,
      };
    }

    case 'subscription.created':
    case 'subscription.updated': {
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

      // Unknown price (codex r4 #15 + cluster-2 round-1 #4 + PR9 codex r5 #9):
      // if the raw Stripe price id is unknown to our PLANS catalog, we cannot
      // trust any state transition that would set `current_plan_id`. This
      // replaces the old `planIdForStripePriceId(priceId) ?? 'free'` silent-
      // downgrade pattern that previously lived in `stripe.ts`. Apply the
      // guard for ALL non-terminal statuses (trialing/active/past_due AND
      // 'none' from `incomplete` — which is pre-payment, not terminal).
      //
      // The outer idempotency wrapper finalizes the event-log row as
      // 'processed' (no Stripe retry) and logs at warn level.
      const rawSub = (event.raw as { data?: { object?: { status?: string; items?: { data?: Array<{ price?: { id?: string } }> } } } })?.data?.object;
      const rawStripeStatus = rawSub?.status;
      const rawPriceId = rawSub?.items?.data?.[0]?.price?.id;
      const isTerminalStripeStatus =
        rawStripeStatus === 'canceled' ||
        rawStripeStatus === 'incomplete_expired' ||
        rawStripeStatus === 'unpaid';
      if (!isTerminalStripeStatus && rawPriceId && planIdForStripePriceId(rawPriceId) === null) {
        logger.warn('Unknown Stripe price ID — skipping state mutation', {
          priceId: rawPriceId,
          eventId: event.providerEventId,
        });
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

      // Audit gap #2 fix: claim the trial reservation. Idempotent — the
      // WHERE clause only matches an unclaimed row. Runs for both
      // subscription.created and subscription.updated so out-of-order
      // events (which Stripe permits) still land the claim.
      if (s.subscriptionId) {
        await manager.query(
          `UPDATE chatbot_tenant_trial_reservations
             SET subscription_id = $1
           WHERE tenant_id = $2 AND subscription_id IS NULL`,
          [s.subscriptionId, tenantId],
        );
      }

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
      // - Already-primary cascades tier ONLY for entitlement-granting statuses
      //   (trialing/active). `none` (= Stripe 'incomplete' / 'incomplete_expired')
      //   and 'cancelled' must not promote `tenants.tier` to a paid plan — the
      //   payment hasn't succeeded yet, and entitlements read `tenants.tier`
      //   directly. `subscription.deleted` cascades to `free` via its own
      //   dedicated handler, not this branch.
      const isPromotion = (s.status === 'trialing' || s.status === 'active') && !row.isPrimary;
      if (isPromotion) {
        await promotePrimaryAndCascadeTier(manager, row, newPlanForStatus);
        return { outcome: 'promoted_primary', invalidateTenantIds: [row.tenantId] };
      }

      const isEntitlementGranting = s.status === 'trialing' || s.status === 'active';
      if (row.isPrimary && isEntitlementGranting) {
        await manager.update(Tenant, { id: tenantId }, { tier: newPlanForStatus });
        // Invalidation deferred to after the outer commit (see return).
        return { outcome: 'tier_cascaded', invalidateTenantIds: [tenantId] };
      }

      if (row.isPrimary && isPastDue) {
        // Grace period — tier preserved.
        return { outcome: 'past_due_grace' };
      }

      if (row.isPrimary) {
        // Primary row with a non-entitlement-granting status (e.g. `none`
        // from `incomplete`, or `cancelled` that didn't go through
        // subscription.deleted). Update row-local fields above already
        // happened; tier stays as-is to avoid handing out paid access on
        // no successful payment.
        return { outcome: 'primary_non_entitlement_no_tier_cascade' };
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

// ---------------------------------------------------------------------------
// PR9 — checkout.session.completed handler (bookkeeping only).
// ---------------------------------------------------------------------------

/**
 * Handler contract (codex round 4 item 4, codex round 5 item 8):
 *  - Re-fetch the Checkout Session with expand=['subscription', 'customer'].
 *  - Skip if mode !== 'subscription' or subscription is null.
 *  - Resolve tenant via fallback chain:
 *      1. session.metadata.tenantId
 *      2. session.customer.metadata.tenantId
 *      3. session.subscription.metadata.tenantId
 *  - On unresolvable tenant: return a special outcome so the wrapper finalizes
 *    the event-log row as 'processed' with last_error='cannot resolve tenant
 *    from checkout session' (no Stripe retry — manual ops intervention).
 *  - Persist customer_id and subscription_id onto the TBA row (idempotent).
 *  - Do NOT update Tenant.tier — that's the subscription.created handler's job.
 */
async function handleCheckoutSessionCompleted(
  manager: EntityManager,
  event: NormalizedEvent,
): Promise<{ outcome: string; meta?: Record<string, unknown> }> {
  const stripe = getStripeClient();
  const rawEvent = event.raw as { data?: { object?: { id?: string } } };
  const sessionId = rawEvent?.data?.object?.id;
  if (!sessionId) {
    return { outcome: 'checkout_session_no_id' };
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription', 'customer'],
  });

  if (session.mode !== 'subscription' || !session.subscription) {
    logger.info('checkout.session.completed ignored (non-subscription mode)', {
      eventId: event.providerEventId,
      sessionId,
      mode: session.mode,
    });
    return { outcome: 'checkout_session_non_subscription' };
  }

  // Tenant resolution fallback chain (metadata only — email fallback is
  // explicitly REJECTED per codex round 3 item 7).
  const sessionTenantId =
    typeof session.metadata?.tenantId === 'string' ? session.metadata.tenantId : null;
  const customerTenantId = (() => {
    if (!session.customer || typeof session.customer === 'string') return null;
    const md = (session.customer as { metadata?: Record<string, string> }).metadata;
    return typeof md?.tenantId === 'string' ? md.tenantId : null;
  })();
  const subscriptionTenantId = (() => {
    if (typeof session.subscription === 'string') return null;
    const md = (session.subscription as { metadata?: Record<string, string> }).metadata;
    return typeof md?.tenantId === 'string' ? md.tenantId : null;
  })();

  const tenantId = sessionTenantId ?? customerTenantId ?? subscriptionTenantId;
  const customerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id ?? null;
  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id ?? null;

  if (!tenantId) {
    logger.error(
      'checkout.session.completed: cannot resolve tenant from metadata',
      {
        eventId: event.providerEventId,
        sessionId,
        customerId,
        subscriptionId,
      },
    );
    return {
      outcome: 'checkout_session_unresolved_tenant',
      meta: { sessionId, customerId, subscriptionId },
    };
  }

  // Lock the tenant's billing rows and find the Stripe TBA row to update.
  await manager
    .createQueryBuilder()
    .select()
    .from(TenantBillingAccount, 'tba')
    .where('tba.tenant_id = :tenantId', { tenantId })
    .setLock('pessimistic_write')
    .getMany();

  const tbaRepo = manager.getRepository(TenantBillingAccount);
  const stripeRow = await tbaRepo.findOne({
    where: { tenantId, provider: 'stripe' },
  });

  if (!stripeRow) {
    logger.warn(
      'checkout.session.completed: no stripe TBA row for resolved tenant',
      { eventId: event.providerEventId, tenantId, customerId, subscriptionId },
    );
    return {
      outcome: 'checkout_session_no_tba_row',
      meta: { tenantId, customerId, subscriptionId },
    };
  }

  // Idempotent updates — re-delivery leaves the same values.
  const updates: { customerId?: string; subscriptionId?: string } = {};
  if (customerId && stripeRow.customerId !== customerId) {
    updates.customerId = customerId;
  }
  if (subscriptionId && stripeRow.subscriptionId !== subscriptionId) {
    updates.subscriptionId = subscriptionId;
  }
  if (Object.keys(updates).length > 0) {
    await tbaRepo.update({ id: stripeRow.id }, updates);
  }

  return {
    outcome: 'checkout_session_bookkeeping_applied',
    meta: { tenantId, customerId, subscriptionId, fieldsUpdated: Object.keys(updates) },
  };
}

// ---------------------------------------------------------------------------
// Audit gap #2 — checkout.session.expired handler (trial-reservation
// release on abandonment).
// ---------------------------------------------------------------------------

/**
 * Releases the trial reservation row this expired Checkout claimed at
 * creation time. The DELETE is scoped by three conditions:
 *
 *   1. `tenant_id` — read from `session.metadata.tenantId` (same source
 *      as the completed handler; no email fallback).
 *   2. `checkout_session_id` — must equal this specific expired session.
 *      Without this, an old expired event could nuke a newer pending row.
 *   3. `subscription_id IS NULL` — a claimed reservation (real trial
 *      consumed) must never be deleted by this path.
 *
 * No Stripe API round-trip needed — the event payload already carries
 * the session id and metadata.
 */
async function handleCheckoutSessionExpired(
  manager: EntityManager,
  event: NormalizedEvent,
): Promise<{ outcome: string; meta?: Record<string, unknown> }> {
  const sessionId = event.sessionId;
  if (!sessionId) {
    return { outcome: 'checkout_expired_no_session_id' };
  }

  // tenantId is the same chain checkout.session.completed uses, minus the
  // fallback to a re-fetched customer (expired sessions never had a
  // subscription, so the customer-metadata path is the most we can pull
  // without a round-trip — and that's fine for cleanup-on-best-effort).
  const raw = event.raw as {
    data?: { object?: { metadata?: Record<string, string> } };
  };
  const tenantId =
    typeof raw?.data?.object?.metadata?.tenantId === 'string'
      ? raw.data.object.metadata.tenantId
      : null;

  if (!tenantId) {
    logger.warn('checkout.session.expired: no tenantId in metadata; cannot release reservation', {
      eventId: event.providerEventId,
      sessionId,
    });
    return { outcome: 'checkout_expired_no_tenant_id', meta: { sessionId } };
  }

  // DELETE…RETURNING via .query() yields [rows, count] — normalize (raw-sql.ts).
  const result = returningRows<{ tenant_id: string }>(await manager.query(
    `DELETE FROM chatbot_tenant_trial_reservations
       WHERE tenant_id = $1
         AND checkout_session_id = $2
         AND subscription_id IS NULL
       RETURNING tenant_id`,
    [tenantId, sessionId],
  ));

  if (result.length === 0) {
    // Either: claimed elsewhere (subscription_id is non-null), already
    // expired-and-released, or the session id doesn't match what we
    // recorded. All three are legitimate no-ops.
    return {
      outcome: 'checkout_expired_reservation_not_released',
      meta: { tenantId, sessionId },
    };
  }

  logger.info('Trial reservation released on checkout abandonment', {
    eventId: event.providerEventId,
    tenantId,
    sessionId,
  });
  return {
    outcome: 'checkout_expired_reservation_released',
    meta: { tenantId, sessionId },
  };
}

// ---------------------------------------------------------------------------
// PR9 — Idempotency wrapper for inbound Stripe webhooks.
// ---------------------------------------------------------------------------

/**
 * Run a Stripe webhook event through the locked PR9 idempotency contract.
 *
 *   BEGIN
 *   pg_try_advisory_xact_lock(hashtext('webhook_event:stripe:' || event_id))
 *   --- if FALSE: ROLLBACK; return { status: 'lock_unavailable' } → HTTP 503
 *   --- if TRUE:
 *   SELECT status, attempts FROM chatbot_stripe_webhook_events WHERE ...
 *   --- if status='processed': ROLLBACK; return { status: 'replay' } → HTTP 200
 *   --- else: UPSERT processing + attempts++
 *   SAVEPOINT handler_body
 *     run callback (mutates Tenant/TBA/AuditLog)
 *   on success: RELEASE SAVEPOINT; UPDATE row → processed
 *   on failure: ROLLBACK TO SAVEPOINT; UPDATE row → failed (+ last_error)
 *   COMMIT (releases the advisory lock; commits the status update either way)
 */
export type StripeIdempotencyOutcome =
  | { status: 'lock_unavailable' }
  | { status: 'replay' }
  | { status: 'processed'; outcome: string; meta?: Record<string, unknown> }
  | { status: 'failed'; error: string };

export interface StripeWebhookCallbackResult {
  outcome: string;
  /** Optional override of the row's final status. Used by the
   *  checkout.session.completed unresolved-tenant path: outcome causes
   *  'processed' + last_error message so Stripe doesn't retry but ops can
   *  still find the failure in event-log queries. */
  finalizeAsProcessedWithError?: string;
  meta?: Record<string, unknown>;
  /** Tenants whose entitlements were mutated — invalidated AFTER the outer
   *  commit (never inside the open tx, where a concurrent miss would re-cache
   *  the pre-commit tier). See `runStripeWebhookIdempotent`. */
  invalidateTenantIds?: string[];
}

export async function runStripeWebhookIdempotent(opts: {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  subscriptionId?: string | null;
  tenantId?: string | null;
  callback: (manager: EntityManager) => Promise<StripeWebhookCallbackResult>;
}): Promise<StripeIdempotencyOutcome> {
  const provider = 'stripe';
  const lockKey = `webhook_event:${provider}:${opts.eventId}`;

  // Run everything inside a single top-level transaction — the advisory
  // lock is xact-scoped so the outer COMMIT/ROLLBACK is what releases it.
  // Use a queryRunner manually so we can issue raw SAVEPOINT / ROLLBACK TO
  // SAVEPOINT statements that TypeORM's transaction helper doesn't expose.
  const queryRunner = AppDataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    // Step A.1 — try to acquire the advisory lock. Failure means a parallel
    // worker is processing the same event; return 503 (codex round 6 item 2).
    const lockRows = await queryRunner.query(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got_lock`,
      [lockKey],
    );
    const gotLock = lockRows?.[0]?.got_lock === true;
    if (!gotLock) {
      await queryRunner.rollbackTransaction();
      return { status: 'lock_unavailable' };
    }

    // Step A.2 — pre-flight check for already-processed events. The advisory
    // lock serialises concurrent attempts so a plain SELECT (no FOR UPDATE)
    // is correct (codex round 5 item 6).
    const existing: Array<{ status: string; attempts: number }> = await queryRunner.query(
      `SELECT status, attempts FROM chatbot_stripe_webhook_events
         WHERE provider = $1 AND event_id = $2`,
      [provider, opts.eventId],
    );
    if (existing.length > 0 && existing[0].status === 'processed') {
      await queryRunner.rollbackTransaction();
      return { status: 'replay' };
    }

    // Step A.3 — upsert to status='processing', attempts++.
    await queryRunner.query(
      `INSERT INTO chatbot_stripe_webhook_events
         (provider, event_id, event_type, status, attempts, subscription_id, tenant_id, payload)
       VALUES ($1, $2, $3, 'processing', 1, $4, $5, $6::jsonb)
       ON CONFLICT (provider, event_id) DO UPDATE SET
         status = 'processing',
         attempts = chatbot_stripe_webhook_events.attempts + 1,
         last_error = NULL,
         tenant_id = COALESCE(EXCLUDED.tenant_id, chatbot_stripe_webhook_events.tenant_id),
         subscription_id = COALESCE(EXCLUDED.subscription_id, chatbot_stripe_webhook_events.subscription_id),
         event_type = EXCLUDED.event_type`,
      [
        provider,
        opts.eventId,
        opts.eventType,
        opts.subscriptionId ?? null,
        opts.tenantId ?? null,
        JSON.stringify(opts.payload),
      ],
    );

    // Step B — handler body in a SAVEPOINT so its mutations can be rolled
    // back independently of the status update we commit in Step C.
    await queryRunner.query(`SAVEPOINT handler_body`);
    let callbackResult: StripeWebhookCallbackResult;
    try {
      callbackResult = await opts.callback(queryRunner.manager);
      await queryRunner.query(`RELEASE SAVEPOINT handler_body`);
    } catch (err) {
      await queryRunner.query(`ROLLBACK TO SAVEPOINT handler_body`);
      const errMsg = err instanceof Error ? err.message : String(err);
      // Step C (failure) — UPDATE row to status='failed' with last_error.
      // Commits with the outer COMMIT below.
      await queryRunner.query(
        `UPDATE chatbot_stripe_webhook_events
            SET status = 'failed', last_error = $1
          WHERE provider = $2 AND event_id = $3`,
        [errMsg, provider, opts.eventId],
      );
      await queryRunner.commitTransaction();
      logger.error('Stripe webhook handler failed; will be retried by Stripe', {
        eventId: opts.eventId,
        eventType: opts.eventType,
        error: errMsg,
      });
      return { status: 'failed', error: errMsg };
    }

    // Step C (success) — UPDATE row to status='processed'. The unresolved-
    // tenant path on checkout.session.completed asks us to finalize as
    // 'processed' with last_error set (so Stripe doesn't retry but the row
    // surfaces the failure for ops queries).
    const finalLastError = callbackResult.finalizeAsProcessedWithError ?? null;
    await queryRunner.query(
      `UPDATE chatbot_stripe_webhook_events
          SET status = 'processed',
              processed_at = now(),
              last_error = $1
        WHERE provider = $2 AND event_id = $3`,
      [finalLastError, provider, opts.eventId],
    );

    await queryRunner.commitTransaction();

    // Cache invalidation happens ONLY here — after the success commit — so a
    // concurrent reader can never re-cache the pre-commit tier for the 60s TTL.
    // (The failure path at the catch above rolled back the mutations, so there
    // is nothing to invalidate there.)
    for (const id of callbackResult.invalidateTenantIds ?? []) {
      await invalidateEntitlementsAndModules(id);
    }

    return {
      status: 'processed',
      outcome: callbackResult.outcome,
      meta: callbackResult.meta,
    };
  } catch (outerErr) {
    // An exception OUTSIDE the SAVEPOINT (rare — only the pre-flight queries
    // or the COMMIT itself). Try to roll back and surface as failure.
    try {
      await queryRunner.rollbackTransaction();
    } catch {
      // ignore — already rolled back or connection dropped
    }
    const errMsg = outerErr instanceof Error ? outerErr.message : String(outerErr);
    logger.error('Stripe webhook outer-tx failure', {
      eventId: opts.eventId,
      eventType: opts.eventType,
      error: errMsg,
    });
    return { status: 'failed', error: errMsg };
  } finally {
    await queryRunner.release();
  }
}
