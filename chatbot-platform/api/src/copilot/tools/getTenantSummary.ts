/**
 * Copilot tool: getTenantSummary
 *
 * Returns the current tenant's plan + billing status. Drives answers to:
 *   - "What plan am I on?"
 *   - "When does my trial end?"
 *   - "When does my subscription renew?"
 *
 * Data sources:
 *   - `tenants.tier` — the marketed plan (essential/pro/enterprise; or
 *     `free` if cancelled and not yet reactivated)
 *   - `tenant_billing_accounts` (where `is_primary = true`) — Stripe-
 *     derived status, trial_end, current_period_end
 *
 * Output is tightly minimised — only fields the prompt needs. No
 * Stripe customer/subscription/price IDs, no payment instruments, no
 * billing email (per invariant #8).
 */
import { Tenant, type TenantTier } from '../../database/entities/Tenant';
import {
  TenantBillingAccount,
  type BillingStatus,
} from '../../database/entities/TenantBillingAccount';
import type { CopilotTool, CopilotToolContext } from './types';

export interface TenantSummaryResult {
  tier: TenantTier;
  status: BillingStatus;
  trialEndsAt: string | null;
  billingPeriodEndsAt: string | null;
}

export const getTenantSummary: CopilotTool<Record<string, never>, TenantSummaryResult> = {
  name: 'getTenantSummary',
  description:
    'Return the current tenant\'s tier (essential/pro/enterprise/free), billing status (trialing/active/past_due/cancelled/none), trial end date, and current billing period end date. No Stripe IDs or payment instruments.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<TenantSummaryResult> {
    const tenant = await ctx.manager.findOne(Tenant, {
      where: { id: ctx.tenantId },
      select: ['id', 'tier'],
    });
    if (!tenant) {
      throw new Error(`getTenantSummary: tenant ${ctx.tenantId} not found`);
    }

    const billing = await ctx.manager.findOne(TenantBillingAccount, {
      where: { tenantId: ctx.tenantId, isPrimary: true },
      select: ['id', 'status', 'trialEnd', 'currentPeriodEnd'],
    });

    return {
      tier: tenant.tier,
      status: (billing?.status ?? 'none') as BillingStatus,
      trialEndsAt: billing?.trialEnd?.toISOString() ?? null,
      billingPeriodEndsAt: billing?.currentPeriodEnd?.toISOString() ?? null,
    };
  },
};
