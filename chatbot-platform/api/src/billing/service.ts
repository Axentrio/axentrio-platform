/**
 * Billing service — high-level operations called by routes, jobs, and
 * tenant-create flows.
 *
 * v1 surface:
 *   - seedTrialAccount              (step 4)
 *   - expireTrialIfStillManual      (step 5)
 *   - findExpiredTrialCandidates    (step 5 — daily sweep)
 *   - sweepExpiredTrials            (step 5)
 *   - startCheckout                 (step 8 — Stripe-driven)
 *   - openCustomerPortal            (step 8 — Stripe-driven)
 *   - changePlan                    (step 8 — Stripe-driven)
 *   - cancelAtPeriodEnd             (step 8 — Stripe-driven)
 *   - undoCancel                    (step 8 — Stripe-driven)
 *   - undoPendingChange             (step 8 — Stripe-driven)
 *   - updateBillingEmail            (step 8 — local-only, self-audit)
 *   - getBillingState               (step 8 — read-only)
 *   - setEnterpriseManual           (step 8 — local-only, self-audit)
 *
 * Plan: .scratch/plan-billing.md § Reverse-trial signup flow,
 *       § Implementation outline steps 4, 5, 8,
 *       § Service-level idempotency & audit-row rules.
 */

import { EntityManager } from 'typeorm';
import { AppDataSource, runInTransaction } from '../database/data-source';
import { BillingEvent } from '../database/entities/BillingEvent';
import { Tenant, TenantTier } from '../database/entities/Tenant';
import {
  BillingPlanId,
  BillingStatus,
  TenantBillingAccount,
} from '../database/entities/TenantBillingAccount';
import { User } from '../database/entities/User';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { getBillingProvider } from './provider-registry';
import { getStripeClient } from './providers/stripe';
import { BillingProviderError, CheckoutablePlanId } from './types';

const STRIPE = 'stripe' as const;

const TRIAL_PLAN_ID = 'pro' as const;

/**
 * Seed a fresh tenant with a manual, trialing-Pro billing account.
 *
 * Idempotent — uses `ON CONFLICT (tenant_id, provider) DO NOTHING` so
 * concurrent callers (admin-create racing autoProvision, retries) cannot
 * double-seed. Only writes the `trial.created` audit + sets `Tenant.tier`
 * when this call is the one that actually inserts the billing row.
 *
 * Called inside the caller's transaction so a failure rolls both back.
 *
 * Returns `{ trialEnd }` if this call seeded the row, or `null` if a
 * billing row already existed (caller should NOT schedule a duplicate
 * expiry job in that case).
 *
 * Plan: .scratch/plan-billing.md § Reverse-trial signup flow.
 */
export async function seedTrialAccount(
  tenantId: string,
  manager: EntityManager,
): Promise<{ trialEnd: Date } | null> {
  const trialEnd = new Date(Date.now() + config.billing.trialDays * 24 * 60 * 60 * 1000);

  // Use raw SQL with explicit RETURNING so the "did we actually insert?"
  // signal is unambiguous. (TypeORM's `.orIgnore()` does not always populate
  // identifiers in a way we can rely on for conflict detection.)
  const inserted: Array<{ id: string }> = await manager.query(
    `INSERT INTO tenant_billing_accounts
       (tenant_id, provider, status, current_plan_id, trial_end, is_primary, raw_provider_data)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)
     ON CONFLICT (tenant_id, provider) DO NOTHING
     RETURNING id`,
    [tenantId, 'manual', 'trialing', TRIAL_PLAN_ID, trialEnd, true],
  );

  if (inserted.length === 0) {
    return null;
  }

  // Only on a fresh seed: ensure tier reflects the trial plan + write audit.
  await manager.update(Tenant, { id: tenantId }, { tier: TRIAL_PLAN_ID });

  const event = manager.create(BillingEvent, {
    tenantId,
    provider: 'system',
    eventType: 'trial.created',
    payload: {
      planId: TRIAL_PLAN_ID,
      trialEnd: trialEnd.toISOString(),
      trialDays: config.billing.trialDays,
    },
  });
  await manager.save(event);

  return { trialEnd };
}

/**
 * Per-tenant trial-expiry check. Idempotent — safe to invoke from both the
 * delayed job (scheduled at tenant-create) and the daily safety-net sweep.
 *
 * Downgrade-only-if:
 *   - the tenant's primary billing row is still manual / trialing / Pro,
 *   - AND no non-manual row younger than 24h exists,
 *   - AND no non-manual row with status in (trialing/active/past_due) exists,
 *   - AND no recent `provider='stripe'` `billing_events` row exists (24h).
 *
 * On downgrade: sets `Tenant.tier='free'`, manual row's status='none' and
 * current_plan_id='free', writes a `billing_events` audit row.
 *
 * Plan: .scratch/plan-billing.md § Reverse-trial signup flow → Trial-expiry job.
 */
export async function expireTrialIfStillManual(tenantId: string): Promise<{
  downgraded: boolean;
  reason?: string;
}> {
  return runInTransaction(async (manager) => {
    const repo = manager.getRepository(TenantBillingAccount);

    // Lock all of this tenant's billing rows for the duration of the tx.
    const rows = await repo
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.tenant_id = :tenantId', { tenantId })
      .getMany();

    const primary = rows.find((r) => r.isPrimary === true);
    if (
      !primary ||
      primary.provider !== 'manual' ||
      primary.status !== 'trialing' ||
      primary.currentPlanId !== TRIAL_PLAN_ID
    ) {
      return { downgraded: false, reason: 'primary_not_eligible' };
    }

    const TWENTY_FOUR_H_MS = 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - TWENTY_FOUR_H_MS);
    const hasFreshNonManualRow = rows.some(
      (r) => r.provider !== 'manual' && r.createdAt > cutoff,
    );
    if (hasFreshNonManualRow) {
      return { downgraded: false, reason: 'fresh_non_manual_row' };
    }

    const hasActiveLikeNonManualRow = rows.some(
      (r) =>
        r.provider !== 'manual' &&
        (r.status === 'trialing' || r.status === 'active' || r.status === 'past_due'),
    );
    if (hasActiveLikeNonManualRow) {
      return { downgraded: false, reason: 'non_manual_active_like' };
    }

    const recentStripeEvent = await manager
      .getRepository(BillingEvent)
      .createQueryBuilder('e')
      .where('e.tenant_id = :tenantId', { tenantId })
      .andWhere('e.provider = :provider', { provider: 'stripe' })
      .andWhere('e.created_at > :cutoff', { cutoff })
      .limit(1)
      .getOne();
    if (recentStripeEvent) {
      return { downgraded: false, reason: 'recent_stripe_event' };
    }

    // Downgrade.
    await manager.update(
      TenantBillingAccount,
      { id: primary.id },
      { status: 'none', currentPlanId: 'free' },
    );
    await manager.update(Tenant, { id: tenantId }, { tier: 'free' });

    const event = manager.create(BillingEvent, {
      tenantId,
      provider: 'system',
      eventType: 'trial.expired',
      payload: {
        downgradedFrom: TRIAL_PLAN_ID,
        downgradedTo: 'free',
      },
    });
    await manager.save(event);

    return { downgraded: true };
  });
}

/**
 * Daily safety-net sweep — returns tenant IDs whose trials have expired
 * and still match the manual / trialing / Pro precondition. Caller
 * dispatches per-tenant expiry jobs for each one (or invokes the service
 * function directly — both are idempotent).
 *
 * The narrow predicate (matches what `expireTrialIfStillManual` checks
 * before downgrading) keeps the dispatch list small — the per-tenant
 * function still re-checks under row lock before committing.
 */
export async function findExpiredTrialCandidates(): Promise<string[]> {
  const rows: Array<{ tenant_id: string }> = await AppDataSource.query(
    `SELECT tenant_id
       FROM tenant_billing_accounts
      WHERE provider = 'manual'
        AND is_primary = true
        AND status = 'trialing'
        AND current_plan_id = 'pro'
        AND trial_end IS NOT NULL
        AND trial_end < now()`,
  );
  return rows.map((r) => r.tenant_id);
}

/**
 * Convenience: run the sweep and process each candidate sequentially.
 * Returns counts for telemetry. Errors per-tenant are logged but do not
 * abort the sweep.
 */
export async function sweepExpiredTrials(): Promise<{
  considered: number;
  downgraded: number;
  skipped: number;
  failed: number;
}> {
  const candidates = await findExpiredTrialCandidates();
  let downgraded = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenantId of candidates) {
    try {
      const result = await expireTrialIfStillManual(tenantId);
      if (result.downgraded) downgraded += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      logger.error('Trial sweep: per-tenant expiry failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { considered: candidates.length, downgraded, skipped, failed };
}

// ---------------------------------------------------------------------------
// Step 8 — high-level service operations on top of BillingProvider adapters.
//
// Stripe-driven operations (startCheckout, changePlan, cancelAtPeriodEnd,
// undoCancel, undoPendingChange, openCustomerPortal) DO NOT write
// `billing_events` audit rows themselves — the audit row is produced by the
// inbound webhook handler (single source of truth, per § Service-level
// idempotency & audit-row rules section A).
//
// Local-only operations (updateBillingEmail, setEnterpriseManual) write
// their own audit row inside the same tx, ONLY when the mutation actually
// changes state (idempotent on repeat calls — per section B).
// ---------------------------------------------------------------------------

async function loadPrimaryBillingRow(
  tenantId: string,
): Promise<TenantBillingAccount | null> {
  return AppDataSource.getRepository(TenantBillingAccount).findOne({
    where: { tenantId, isPrimary: true },
  });
}

/**
 * Resolve `(email, name)` for `stripe.customers.create`. Prefers the primary
 * row's `billing_email` if set; otherwise falls back to the first admin user
 * (oldest admin by `createdAt`). Name always comes from `tenants.name`.
 *
 * Throws if no admin exists and no primary `billing_email` is set — UI
 * should not allow checkout without one of those.
 */
async function resolveCheckoutIdentity(
  tenantId: string,
): Promise<{ email: string; name: string }> {
  const [primary, tenant] = await Promise.all([
    loadPrimaryBillingRow(tenantId),
    AppDataSource.getRepository(Tenant).findOne({
      where: { id: tenantId },
      select: ['id', 'name'],
    }),
  ]);
  if (!tenant) {
    throw new Error(`resolveCheckoutIdentity: tenant ${tenantId} not found`);
  }
  let email = primary?.billingEmail ?? null;
  if (!email) {
    // Tenants seeded with a super_admin owner (e.g. via SUPER_ADMIN_EMAILS)
    // won't have a plain 'admin' row. Both roles are billing-eligible —
    // super_admin is strictly more privileged. Prefer 'admin' when both
    // exist; otherwise pick the oldest admin-equivalent.
    const adminEquivalent = await AppDataSource.getRepository(User)
      .createQueryBuilder('u')
      .select(['u.id', 'u.email', 'u.name', 'u.role', 'u.createdAt'])
      .where('u.tenant_id = :tenantId', { tenantId })
      .andWhere('u.role IN (:...roles)', { roles: ['admin', 'super_admin'] })
      .andWhere('u.is_active = true')
      // 'admin' first, then 'super_admin', then by createdAt
      .orderBy("CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END", 'ASC')
      .addOrderBy('u.createdAt', 'ASC')
      .getOne();
    if (!adminEquivalent) {
      throw new BillingProviderError('billing_email_unresolvable', STRIPE, {
        tenantId,
      });
    }
    email = adminEquivalent.email;
  }
  return { email, name: tenant.name };
}

/**
 * Start a Stripe Checkout session for `planId`. Plan: § Reverse-trial signup
 * flow → Subscribe flow (steps 1–4).
 *
 * Two short transactions wrap the Stripe API calls:
 *   1. Duplicate-checkout guard (read-only — locks tenant rows, validates
 *      that the primary row is NOT an active Stripe sub, releases).
 *   2. COALESCE upsert — persists `customer_id` while preserving any
 *      pre-existing non-null value (round-5 #1).
 * The Stripe calls themselves run with NO DB lock held.
 *
 * NO audit row written by the service — the webhook handler is the
 * authoritative audit source for the resulting `customer.subscription.*`
 * event (per § Service-level idempotency & audit-row rules section A).
 */
export async function startCheckout(
  tenantId: string,
  planId: CheckoutablePlanId,
  returnUrls: { successUrl: string; cancelUrl: string },
): Promise<{ url: string }> {
  // Step 1: defensive plan-id validation. The TS type prevents 'free' /
  // 'enterprise' at the callsite, but runtime callers (route handlers
  // parsing JSON) need a guard too.
  if (planId !== 'pro' && planId !== 'premium') {
    throw new BillingProviderError('checkout_plan_invalid', STRIPE, { planId });
  }

  // Step 2: Duplicate-checkout guard (round-5 #2). Short read-only tx;
  // locks all of the tenant's billing rows so a concurrent startCheckout
  // can't slip in between this check and the upsert in step 4.
  await runInTransaction(async (manager) => {
    const rows = await manager
      .getRepository(TenantBillingAccount)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.tenant_id = :tenantId', { tenantId })
      .getMany();
    const primary = rows.find((r) => r.isPrimary === true);
    if (
      primary &&
      primary.provider === STRIPE &&
      (primary.status === 'trialing' ||
        primary.status === 'active' ||
        primary.status === 'past_due')
    ) {
      throw new BillingProviderError('subscription_exists', STRIPE, {
        tenantId,
      });
    }
  });

  // Step 3: Resolve Stripe customer. No DB lock — search-then-create is
  // durable on its own (the orphan-customer race is an accepted v1 cut).
  const { email, name } = await resolveCheckoutIdentity(tenantId);
  const stripeProvider = getBillingProvider(STRIPE);
  const { customerId: resolvedCustomerId } = await stripeProvider.createCustomer({
    tenantId,
    email,
    name,
  });

  // Step 4: COALESCE upsert (round-5 #1). Short tx with row lock; persisted
  // `customer_id` is never overwritten when non-null, so a concurrent
  // duplicate startCheckout that resolved a different customer simply
  // leaks an orphan customer in Stripe (accepted) rather than corrupting
  // local state.
  await runInTransaction(async (manager) => {
    await manager
      .getRepository(TenantBillingAccount)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.tenant_id = :tenantId', { tenantId })
      .getMany();
    await manager.query(
      `INSERT INTO tenant_billing_accounts
         (tenant_id, provider, status, current_plan_id, customer_id,
          is_primary, raw_provider_data)
       VALUES ($1, 'stripe', 'none', 'free', $2, false, '{}'::jsonb)
       ON CONFLICT (tenant_id, provider) DO UPDATE
         SET customer_id = COALESCE(
               tenant_billing_accounts.customer_id,
               EXCLUDED.customer_id
             ),
             updated_at = now()`,
      [tenantId, resolvedCustomerId],
    );
  });

  // Step 5: Create checkout session. The provider re-reads the row's
  // persisted `customer_id` itself (it does NOT trust the local variable
  // from step 3), so the COALESCE outcome is the source of truth.
  return stripeProvider.createCheckoutSession({
    tenantId,
    planId,
    successUrl: returnUrls.successUrl,
    cancelUrl: returnUrls.cancelUrl,
  });
}

/**
 * Open a Stripe Customer Portal session. Rejects with `no_stripe_subscription`
 * when the tenant's primary billing row is not a Stripe row (free / manual-
 * trial / enterprise tenants — UI shows Subscribe / Contact sales instead).
 */
export async function openCustomerPortal(
  tenantId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  const primary = await loadPrimaryBillingRow(tenantId);
  if (!primary || primary.provider !== STRIPE) {
    throw new BillingProviderError('no_stripe_subscription', STRIPE, { tenantId });
  }
  return getBillingProvider(STRIPE).createPortalSession({ tenantId, returnUrl });
}

/**
 * Change the tenant's subscription plan. Full validation chain per
 * § Service-level validation:
 *   - no primary Stripe row    → `no_stripe_subscription`
 *   - status='past_due'        → `past_due_block`
 *   - local pendingPlanId set  → `pending_change_exists`
 *   - same plan (live Stripe)  → silent no-op (idempotent)
 *   - remote pendingPlanId set → `pending_change_exists`
 *
 * NO audit row — webhook produces it.
 */
export async function changePlan(
  tenantId: string,
  newPlanId: CheckoutablePlanId,
): Promise<void> {
  if (newPlanId !== 'pro' && newPlanId !== 'premium') {
    throw new BillingProviderError('checkout_plan_invalid', STRIPE, {
      planId: newPlanId,
    });
  }

  const primary = await loadPrimaryBillingRow(tenantId);
  if (!primary || primary.provider !== STRIPE) {
    throw new BillingProviderError('no_stripe_subscription', STRIPE, { tenantId });
  }
  if (primary.status === 'past_due') {
    throw new BillingProviderError('past_due_block', STRIPE);
  }
  if (primary.pendingPlanId) {
    throw new BillingProviderError('pending_change_exists', STRIPE);
  }

  // Pre-call idempotency check (live Stripe). If the target state is
  // already true, skip the Stripe mutation — no webhook fires, no audit
  // row, no churn for the user clicking Change twice.
  const stripeProvider = getBillingProvider(STRIPE);
  const sub = await stripeProvider.getSubscription({ tenantId });
  if (!sub) {
    throw new BillingProviderError('no_stripe_subscription', STRIPE, { tenantId });
  }
  if (sub.currentPlanId === newPlanId) {
    return; // already on this plan
  }
  if (sub.pendingPlanId) {
    // Remote schedule exists that local DB hasn't yet seen via webhook —
    // surface symmetrically so the user gets the same error either way.
    throw new BillingProviderError('pending_change_exists', STRIPE);
  }

  await stripeProvider.changeSubscription({ tenantId, newPlanId });
}

/**
 * Set `cancel_at_period_end=true`. Idempotent: pre-call live-Stripe check
 * skips the mutation when already true. NO audit row — webhook produces it.
 */
export async function cancelAtPeriodEnd(tenantId: string): Promise<void> {
  const primary = await loadPrimaryBillingRow(tenantId);
  if (!primary || primary.provider !== STRIPE) {
    throw new BillingProviderError('no_stripe_subscription', STRIPE, { tenantId });
  }
  const stripeProvider = getBillingProvider(STRIPE);
  const sub = await stripeProvider.getSubscription({ tenantId });
  if (!sub) {
    throw new BillingProviderError('no_stripe_subscription', STRIPE, { tenantId });
  }
  if (sub.cancelAtPeriodEnd === true) {
    return; // already scheduled
  }
  await stripeProvider.cancelSubscription({ tenantId, atPeriodEnd: true });
}

/**
 * Clear a pending end-of-period cancellation. Idempotent: pre-call check
 * skips when already false. NO audit row — webhook produces it.
 */
export async function undoCancel(tenantId: string): Promise<void> {
  const primary = await loadPrimaryBillingRow(tenantId);
  if (!primary || primary.provider !== STRIPE) {
    throw new BillingProviderError('no_stripe_subscription', STRIPE, { tenantId });
  }
  const stripeProvider = getBillingProvider(STRIPE);
  const sub = await stripeProvider.getSubscription({ tenantId });
  if (!sub) {
    throw new BillingProviderError('no_stripe_subscription', STRIPE, { tenantId });
  }
  if (sub.cancelAtPeriodEnd === false) {
    return; // nothing to undo
  }
  await stripeProvider.undoCancel({ tenantId });
}

/**
 * Release a pending downgrade schedule. Idempotent: pre-call check skips
 * when no pending change exists. NO audit row — webhook produces it.
 */
export async function undoPendingChange(tenantId: string): Promise<void> {
  const primary = await loadPrimaryBillingRow(tenantId);
  if (!primary || primary.provider !== STRIPE) {
    throw new BillingProviderError('no_stripe_subscription', STRIPE, { tenantId });
  }
  const stripeProvider = getBillingProvider(STRIPE);
  const sub = await stripeProvider.getSubscription({ tenantId });
  if (!sub) {
    throw new BillingProviderError('no_stripe_subscription', STRIPE, { tenantId });
  }
  if (sub.pendingPlanId === null) {
    return; // nothing to release
  }
  await stripeProvider.undoPendingChange({ tenantId });
}

/**
 * Update the tenant's billing email. Local-only operation per
 * § billing_email propagation rule:
 *   - Open local tx, lock all of the tenant's billing rows.
 *   - Update the primary row's `billing_email`.
 *   - If the primary row is a Stripe row with a `customer_id`, call
 *     `stripe.customers.update(customerId, { email })` INSIDE the tx so a
 *     Stripe failure rolls the local change back.
 *   - Audit row written only when the email actually changed (idempotent
 *     on repeat calls — section B).
 */
export async function updateBillingEmail(
  tenantId: string,
  email: string,
): Promise<{ changed: boolean }> {
  return runInTransaction(async (manager) => {
    const rows = await manager
      .getRepository(TenantBillingAccount)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.tenant_id = :tenantId', { tenantId })
      .getMany();

    const primary = rows.find((r) => r.isPrimary === true);
    if (!primary) {
      throw new BillingProviderError('no_active_account', STRIPE, { tenantId });
    }

    const previousEmail = primary.billingEmail ?? null;
    if (previousEmail === email) {
      return { changed: false };
    }

    await manager.update(
      TenantBillingAccount,
      { id: primary.id },
      { billingEmail: email },
    );

    // Propagate to Stripe BEFORE writing the audit row — if Stripe throws,
    // the tx rolls back the local row update AND the audit insert atomically.
    if (primary.provider === STRIPE && primary.customerId) {
      await getStripeClient().customers.update(primary.customerId, { email });
    }

    const event = manager.create(BillingEvent, {
      tenantId,
      provider: 'system',
      eventType: 'billing.email.updated',
      payload: {
        previousEmail,
        newEmail: email,
        provider: primary.provider,
      },
    });
    await manager.save(event);

    return { changed: true };
  });
}

/**
 * Read-only snapshot of the tenant's billing state — used by the portal
 * Billing page and by route-level UI gating. Returns primary-row fields,
 * an aggregated `hasStripeSubscription` flag for "Subscribe" vs "Manage"
 * UI decisions, and the last 20 `billing_events` rows.
 */
export interface BillingHistoryEntry {
  id: string;
  provider: 'stripe' | 'manual' | 'system';
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface BillingState {
  tier: TenantTier;
  primaryProvider: 'stripe' | 'manual';
  planId: BillingPlanId;
  status: BillingStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pendingPlanId: BillingPlanId | null;
  pendingPlanEffectiveAt: Date | null;
  trialEnd: Date | null;
  billingEmail: string | null;
  hasStripeSubscription: boolean;
  events: BillingHistoryEntry[];
}

export async function getBillingState(tenantId: string): Promise<BillingState> {
  const [tenant, primary, allRows, events] = await Promise.all([
    AppDataSource.getRepository(Tenant).findOne({
      where: { id: tenantId },
      select: ['id', 'tier'],
    }),
    loadPrimaryBillingRow(tenantId),
    AppDataSource.getRepository(TenantBillingAccount).find({
      where: { tenantId },
    }),
    AppDataSource.getRepository(BillingEvent).find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: 20,
    }),
  ]);

  if (!tenant) {
    throw new Error(`getBillingState: tenant ${tenantId} not found`);
  }
  if (!primary) {
    throw new Error(`getBillingState: tenant ${tenantId} has no primary billing row`);
  }

  const hasStripeSubscription = allRows.some(
    (r) =>
      r.provider === STRIPE &&
      !!r.subscriptionId &&
      (r.status === 'trialing' ||
        r.status === 'active' ||
        r.status === 'past_due'),
  );

  return {
    tier: tenant.tier,
    primaryProvider: primary.provider,
    planId: primary.currentPlanId,
    status: primary.status,
    currentPeriodEnd: primary.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: primary.cancelAtPeriodEnd,
    pendingPlanId: primary.pendingPlanId ?? null,
    pendingPlanEffectiveAt: primary.pendingPlanEffectiveAt ?? null,
    trialEnd: primary.trialEnd ?? null,
    billingEmail: primary.billingEmail ?? null,
    hasStripeSubscription,
    events: events.map((e) => ({
      id: e.id,
      provider: e.provider,
      eventType: e.eventType,
      payload: e.payload,
      createdAt: e.createdAt,
    })),
  };
}

/**
 * Super-admin "Set tier (manual)" — general tier override that bypasses
 * Stripe. Used for sales-managed Enterprise, comps (Pro/Premium given
 * away), and refund/abuse-driven downgrades to Free.
 *
 * Single tx with `SELECT … FOR UPDATE` on all the tenant's billing rows:
 *   1. Demote every existing is_primary=true row (so the partial unique
 *      index on (tenant_id) WHERE is_primary is never violated by step 2).
 *   2. Upsert (tenant_id, provider='manual') with the target plan/status
 *      and is_primary=true.
 *   3. Set Tenant.tier to the target tier.
 *   4. Write 'tier.manual_override' audit row.
 *
 * Idempotent: if the tenant is already on the target manual primary row,
 * the call no-ops (no audit row) UNLESS opts.* fields change.
 *
 * Status mapping:
 *   - free       → status='none'   (no plan, matches trial-expiry end-state)
 *   - pro/premium → status='active' (comped — full entitlements)
 *   - enterprise → status='active' (sales-managed)
 *
 * `opts.currentPeriodEnd` and `opts.billingEmail` may stay null — entitlement
 * resolution doesn't read either (codex r4 #13).
 *
 * Note: when an existing Stripe subscription is present, it stays in Stripe
 * — super-admin is prompted to cancel it in the Stripe dashboard. The Stripe
 * row remains in our DB but is now non-primary, so its webhooks only update
 * row-local state (per § Primary-switch & tier-cascade rules item 3).
 */
export async function setTierManual(
  tenantId: string,
  tier: TenantTier,
  opts: {
    currentPeriodEnd?: Date | null;
    billingEmail?: string | null;
  } = {},
): Promise<{ changed: boolean }> {
  const targetStatus: BillingStatus = tier === 'free' ? 'none' : 'active';
  const targetPlanId: BillingPlanId = tier;

  return runInTransaction(async (manager) => {
    const rows = await manager
      .getRepository(TenantBillingAccount)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.tenant_id = :tenantId', { tenantId })
      .getMany();

    const tenant = await manager.findOneOrFail(Tenant, {
      where: { id: tenantId },
    });

    const existingManual = rows.find((r) => r.provider === 'manual');
    const alreadyOnTarget =
      tenant.tier === tier &&
      existingManual?.isPrimary === true &&
      existingManual.currentPlanId === targetPlanId &&
      existingManual.status === targetStatus;

    if (alreadyOnTarget) {
      // Allow opt-field updates without rewriting tier/status/is_primary.
      // Plain object (not Partial<entity>) to avoid TypeORM's deep-partial
      // recursing through the Tenant relation graph (same pattern as events.ts).
      const updateFields: {
        currentPeriodEnd?: Date | null;
        billingEmail?: string | null;
      } = {};
      if (
        opts.currentPeriodEnd !== undefined &&
        opts.currentPeriodEnd !== (existingManual.currentPeriodEnd ?? null)
      ) {
        updateFields.currentPeriodEnd = opts.currentPeriodEnd;
      }
      if (
        opts.billingEmail !== undefined &&
        opts.billingEmail !== (existingManual.billingEmail ?? null)
      ) {
        updateFields.billingEmail = opts.billingEmail;
      }
      if (Object.keys(updateFields).length === 0) {
        return { changed: false };
      }
      await manager.update(
        TenantBillingAccount,
        { id: existingManual.id },
        updateFields,
      );
      const event = manager.create(BillingEvent, {
        tenantId,
        provider: 'system',
        eventType: 'tier.manual_override',
        payload: {
          previousTier: tenant.tier,
          newTier: tier,
          fieldUpdates: {
            currentPeriodEnd:
              opts.currentPeriodEnd !== undefined
                ? opts.currentPeriodEnd?.toISOString() ?? null
                : undefined,
            billingEmail:
              opts.billingEmail !== undefined ? opts.billingEmail : undefined,
          },
        },
      });
      await manager.save(event);
      return { changed: true };
    }

    // Step 1: demote every currently-primary row so the partial unique
    // index has no conflict with the upsert in step 2.
    await manager.query(
      `UPDATE tenant_billing_accounts
          SET is_primary = false, updated_at = now()
        WHERE tenant_id = $1 AND is_primary = true`,
      [tenantId],
    );

    // Step 2: upsert the manual row as the new primary account.
    // COALESCE for opt fields preserves existing values when caller passes null.
    const periodEndArg = opts.currentPeriodEnd ?? null;
    const billingEmailArg = opts.billingEmail ?? null;
    await manager.query(
      `INSERT INTO tenant_billing_accounts
         (tenant_id, provider, status, current_plan_id, is_primary,
          current_period_end, billing_email, raw_provider_data)
       VALUES ($1, 'manual', $2, $3, true, $4, $5, '{}'::jsonb)
       ON CONFLICT (tenant_id, provider) DO UPDATE
         SET status = $2,
             current_plan_id = $3,
             is_primary = true,
             current_period_end = COALESCE($4, tenant_billing_accounts.current_period_end),
             billing_email = COALESCE($5, tenant_billing_accounts.billing_email),
             updated_at = now()`,
      [tenantId, targetStatus, targetPlanId, periodEndArg, billingEmailArg],
    );

    // Step 3: tenant tier cascade.
    const previousTier = tenant.tier;
    await manager.update(Tenant, { id: tenantId }, { tier });

    // Step 4: audit row.
    const event = manager.create(BillingEvent, {
      tenantId,
      provider: 'system',
      eventType: 'tier.manual_override',
      payload: {
        previousTier,
        newTier: tier,
        previousPrimary:
          rows.find((r) => r.isPrimary === true)?.provider ?? null,
        currentPeriodEnd: periodEndArg?.toISOString() ?? null,
        billingEmail: billingEmailArg,
      },
    });
    await manager.save(event);

    return { changed: true };
  });
}

/**
 * Thin wrapper around `setTierManual` for the Enterprise-specific path —
 * kept for callers that already use this name. New code should call
 * `setTierManual` directly with the target tier.
 */
export async function setEnterpriseManual(
  tenantId: string,
  opts: {
    currentPeriodEnd?: Date | null;
    billingEmail?: string | null;
  } = {},
): Promise<{ changed: boolean }> {
  return setTierManual(tenantId, 'enterprise', opts);
}

// Re-export plan-level types so route handlers can validate inputs without
// reaching into ./types directly. Keeps the service module a single
// import surface for billing operations.
export type { CheckoutablePlanId, InternalPlanId } from './types';
