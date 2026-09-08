import Stripe from 'stripe';
import { AppDataSource } from '../database/data-source';
import { TenantBillingAccount } from '../database/entities/TenantBillingAccount';
import { resolveOwnerLanguage } from '../i18n/audience-language';
import { invalidateEntitlementsAndModules } from '../modules';
import { emailDeliveryService } from '../services/email-delivery.service';
import { logger } from '../utils/logger';
import { returningRows } from '../utils/raw-sql';
import { renderDunningEmail } from './dunning-copy';
import {
  DUNNING_GRACE_MS,
  type DunningDay,
  graceEndsAt,
} from './dunning-clock';
import { getStripeClient } from './providers/stripe';
import { resolveBillingEmail } from './service';
import { BillingProviderError } from './types';

export {
  DUNNING_GRACE_MS,
  DUNNING_SWEEP_MS,
  graceEndsAt,
  type DunningDay,
} from './dunning-clock';

const DAY_MS = 24 * 60 * 60 * 1000;

function highestDueDay(elapsedMs: number): DunningDay {
  if (elapsedMs >= 2 * DAY_MS) return 2;
  if (elapsedMs >= DAY_MS) return 1;
  return 0;
}

function isSubscriptionScoped(subscriptionId: string | null | undefined): boolean {
  return typeof subscriptionId === 'string' && subscriptionId.length > 0;
}

export async function sendDunningReminder(
  tenantId: string,
  day: DunningDay,
  now?: Date,
): Promise<void> {
  const row = await AppDataSource.getRepository(TenantBillingAccount).findOne({
    where: { tenantId, isPrimary: true },
  });
  if (!row || row.status !== 'past_due' || !row.dunningStartedAt) return;

  const started = row.dunningStartedAt;
  const at = now ?? new Date();
  if (at.getTime() >= graceEndsAt(started).getTime()) return;

  let recipientEmail: string;
  try {
    recipientEmail = await resolveBillingEmail(tenantId);
  } catch (error) {
    if (error instanceof BillingProviderError && error.code === 'billing_email_unresolvable') {
      logger.warn('billing_dunning_email_unresolvable', { tenantId });
      return;
    }
    throw error;
  }

  const locale = await resolveOwnerLanguage(tenantId, recipientEmail);
  const { subject, body } = renderDunningEmail({
    locale,
    day,
    plan: row.currentPlanId,
    graceEndsAt: graceEndsAt(started),
  });

  await emailDeliveryService.sendDurable({
    tenantId,
    recipientEmail,
    subject,
    body,
    kind: 'billing_dunning',
    relatedId: tenantId,
    idempotencyKey: `billing_dunning:${tenantId}:${started.toISOString()}:day${day}`,
  });
}

let dunningSweepInFlight = false;

export async function runDunningSweep(
  now?: Date,
): Promise<{ reminded: number; dropped: number }> {
  if (dunningSweepInFlight) return { reminded: 0, dropped: 0 };
  dunningSweepInFlight = true;
  try {
    const at = now ?? new Date();
    const rows = await AppDataSource.getRepository(TenantBillingAccount).find({
      where: { provider: 'stripe', status: 'past_due', isPrimary: true },
    });

    let reminded = 0;
    let dropped = 0;
    for (const row of rows) {
      if (!row.dunningStartedAt) continue;
      try {
        const elapsed = at.getTime() - row.dunningStartedAt.getTime();
        if (elapsed >= DUNNING_GRACE_MS) {
          const result = await cancelPastDueSubscriptionNow(row.tenantId, at);
          if (result === 'dropped') dropped += 1;
          continue;
        }
        await sendDunningReminder(row.tenantId, highestDueDay(elapsed), at);
        reminded += 1;
      } catch (error) {
        logger.error('Billing dunning sweep row failed', {
          tenantId: row.tenantId,
          error,
        });
      }
    }
    return { reminded, dropped };
  } finally {
    dunningSweepInFlight = false;
  }
}

export async function cancelPastDueSubscriptionNow(
  tenantId: string,
  now?: Date,
): Promise<'dropped' | 'skipped'> {
  const at = now ?? new Date();
  const repo = AppDataSource.getRepository(TenantBillingAccount);
  const row = await repo.findOne({ where: { tenantId, isPrimary: true } });
  if (
    !row ||
    row.provider !== 'stripe' ||
    row.status !== 'past_due' ||
    !isSubscriptionScoped(row.subscriptionId) ||
    !row.dunningStartedAt ||
    at.getTime() < graceEndsAt(row.dunningStartedAt).getTime()
  ) {
    return 'skipped';
  }

  try {
    await getStripeClient().subscriptions.cancel(row.subscriptionId!);
  } catch (error) {
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === 'resource_missing'
    ) {
      // Dashboard already cancelled — still drop locally.
    } else {
      logger.error('Billing dunning Stripe cancel failed', { tenantId, error });
      return 'skipped';
    }
  }

  const dropped = returningRows<{ id: string }>(
    await AppDataSource.query(
      `WITH dropped AS (
         UPDATE tenant_billing_accounts
            SET status = 'cancelled',
                current_plan_id = 'free',
                pending_plan_id = NULL,
                pending_plan_effective_at = NULL,
                trial_end = NULL,
                current_period_end = NULL,
                cancel_at_period_end = false,
                subscription_id = NULL,
                dunning_started_at = NULL,
                updated_at = now()
          WHERE id = $1 AND status = 'past_due' AND is_primary = true
          RETURNING tenant_id
       )
       UPDATE tenants
          SET tier = 'free',
              updated_at = now()
        WHERE id IN (SELECT tenant_id FROM dropped)
        RETURNING id`,
      [row.id],
    ),
  );
  if (dropped.length === 0) return 'skipped';
  await invalidateEntitlementsAndModules(tenantId);
  return 'dropped';
}
