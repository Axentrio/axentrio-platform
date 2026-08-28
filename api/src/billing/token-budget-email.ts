import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { emailDeliveryService } from '../services/email-delivery.service';
import { BillingProviderError } from './types';
import { resolveBillingEmail } from './service';
import type { TokenBudgetSnapshot } from './token-budget.service';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function sendTokenBudgetWarning(
  tenantId: string,
  balanceRowId: string,
  snapshot: TokenBudgetSnapshot,
): Promise<void> {
  let recipientEmail: string;
  try {
    recipientEmail = await resolveBillingEmail(tenantId);
  } catch (error) {
    if (error instanceof BillingProviderError && error.code === 'billing_email_unresolvable') {
      logger.warn('token_budget_warning_email_unresolvable', { tenantId });
      return;
    }
    throw error;
  }

  const billingUrl = `${config.portal.url}/settings/billing`;
  const periodEnd = snapshot.periodEnd.toISOString().slice(0, 10);
  const used = snapshot.usedTokens.toLocaleString('en-GB');
  const allowance = (snapshot.allowanceTokens + snapshot.topUpTokens).toLocaleString('en-GB');
  const body = [
    '<p>You have used 80% of your AI usage allowance.</p>',
    `<p>Tokens used: ${escapeHtml(used)}<br>` +
      `Allowance (plan + top-up): ${escapeHtml(allowance)}<br>` +
      `Period ends: ${escapeHtml(periodEnd)}</p>`,
    '<p>The assistant stops at 110% of your allowance.</p>',
    `<p><a href="${escapeHtml(billingUrl)}">Open billing settings</a> to buy more tokens.</p>`,
  ].join('');

  await emailDeliveryService.sendDurable({
    tenantId,
    recipientEmail,
    subject: 'You have used 80% of your AI usage allowance',
    body,
    kind: 'token_budget_80',
    relatedId: balanceRowId,
    idempotencyKey: `token_budget_80:${tenantId}:${snapshot.periodStart.toISOString().slice(0, 10)}`,
  });
}
