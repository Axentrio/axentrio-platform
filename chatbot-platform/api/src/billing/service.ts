/**
 * Billing service — high-level operations called by routes, jobs, and
 * tenant-create flows.
 *
 * v1 surface (this file grows in steps 4, 5, and 8 of the plan):
 *   - seedTrialAccount              (step 4)
 *   - expireTrialIfStillManual      (step 5)
 *   - findExpiredTrialCandidates    (step 5 — daily sweep)
 *   - (step 8 will add startCheckout, changePlan, cancel, etc.)
 *
 * Plan: .scratch/plan-billing.md § Reverse-trial signup flow,
 *       § Implementation outline steps 4, 5, 8.
 */

import { EntityManager } from 'typeorm';
import { AppDataSource, runInTransaction } from '../database/data-source';
import { BillingEvent } from '../database/entities/BillingEvent';
import { Tenant } from '../database/entities/Tenant';
import { TenantBillingAccount } from '../database/entities/TenantBillingAccount';
import { config } from '../config/environment';
import { logger } from '../utils/logger';

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
