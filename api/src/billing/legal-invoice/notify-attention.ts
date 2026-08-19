import { IsNull } from 'typeorm';
import { config } from '../../config/environment';
import { AppDataSource } from '../../database/data-source';
import { LegalInvoice } from '../../database/entities/LegalInvoice';
import { Tenant } from '../../database/entities/Tenant';
import { User } from '../../database/entities/User';
import { emailDeliveryService } from '../../services/email-delivery.service';
import { logger } from '../../utils/logger';
import type { LegalDocumentKind, LegalInvoiceStatus } from './types';

const ATTENTION_STATUSES: LegalInvoiceStatus[] = ['failed', 'manual_review'];
export const LEGAL_INVOICE_ALERT_KIND = 'legal_invoice';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatAmount(cents: number, currency: string): string {
  return `${(Math.round(cents) / 100).toFixed(2)} ${currency}`;
}

function documentLabel(kind: LegalDocumentKind): string {
  return kind === 'credit_note' ? 'Credit Note' : 'Legal Invoice';
}

export function uniqueSuperAdminRecipients(
  users: Array<{ id: string; email: string }>,
): Array<{ id: string; email: string }> {
  const seen = new Set<string>();
  const unique: Array<{ id: string; email: string }> = [];
  for (const user of users) {
    const email = user.email.trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    unique.push({ id: user.id, email });
  }
  return unique;
}

export function legalInvoiceAttentionDeepLink(legalInvoiceId?: string): string {
  const base = `${config.portal.url.replace(/\/$/, '')}/admin/legal-invoices`;
  if (!legalInvoiceId) return base;
  return `${base}?invoice=${encodeURIComponent(legalInvoiceId)}`;
}

export function renderLegalInvoiceAttentionEmail(input: {
  tenantName: string;
  documentKind: LegalDocumentKind;
  invoiceStatus: LegalInvoiceStatus;
  lastError: string | null;
  amountInclCents: number;
  currency: string;
  stripeInvoiceId?: string | null;
  stripeRefundId?: string | null;
  deepLink: string;
}): { subject: string; body: string } {
  const label = documentLabel(input.documentKind);
  const error = (input.lastError ?? '').trim() || 'none';
  const lines = [
    `Tenant: ${escapeHtml(input.tenantName)}`,
    `Document: ${escapeHtml(input.documentKind)}`,
    `Status: ${escapeHtml(input.invoiceStatus)}`,
    `Error: ${escapeHtml(error)}`,
    `Amount: ${escapeHtml(formatAmount(input.amountInclCents, input.currency))}`,
  ];
  if (input.stripeInvoiceId) {
    lines.push(`Stripe invoice: ${escapeHtml(input.stripeInvoiceId)}`);
  }
  if (input.stripeRefundId) {
    lines.push(`Stripe refund: ${escapeHtml(input.stripeRefundId)}`);
  }

  return {
    subject: `${label} needs attention`,
    body: [
      `<p>A ${escapeHtml(label)} needs your attention.</p>`,
      `<p>${lines.join('<br>')}</p>`,
      `<p><a href="${escapeHtml(input.deepLink)}">Open Legal Invoices</a></p>`,
    ].join(''),
  };
}

export function needsLegalInvoiceAttention(row: {
  invoiceStatus: LegalInvoiceStatus;
}): boolean {
  return ATTENTION_STATUSES.includes(row.invoiceStatus);
}

export async function notifyLegalInvoiceAttention(row: LegalInvoice): Promise<void> {
  if (!row.id || !needsLegalInvoiceAttention(row)) return;

  try {
    const recipients = await AppDataSource.getRepository(User).find({
      where: { role: 'super_admin', isActive: true, deletedAt: IsNull() },
      select: ['id', 'email'],
    });
    const deliverable = uniqueSuperAdminRecipients(recipients);
    if (deliverable.length === 0) {
      logger.warn('Legal invoice needs attention but no Super Admin recipient', {
        legalInvoiceId: row.id,
        invoiceStatus: row.invoiceStatus,
        lastError: row.lastError,
      });
      return;
    }

    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: row.tenantId },
      select: ['id', 'name'],
    });
    const email = renderLegalInvoiceAttentionEmail({
      tenantName: tenant?.name ?? 'Unknown tenant',
      documentKind: row.documentKind,
      invoiceStatus: row.invoiceStatus,
      lastError: row.lastError ?? null,
      amountInclCents: row.amountInclCents,
      currency: row.currency,
      stripeInvoiceId: row.stripeInvoiceId,
      stripeRefundId: row.stripeRefundId,
      deepLink: legalInvoiceAttentionDeepLink(row.id),
    });

    const results = await Promise.allSettled(
      deliverable.map((user) =>
        emailDeliveryService.sendDurable({
          tenantId: row.tenantId,
          recipientUserId: user.id,
          recipientEmail: user.email,
          subject: email.subject,
          body: email.body,
          kind: LEGAL_INVOICE_ALERT_KIND,
          relatedId: row.id,
          idempotencyKey: `${LEGAL_INVOICE_ALERT_KIND}:${row.id}:${row.invoiceStatus}:${user.email.toLowerCase()}`,
        }),
      ),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn('Legal invoice attention email failed', {
          legalInvoiceId: row.id,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        continue;
      }
      if (result.value.status === 'failed') {
        logger.warn('Legal invoice attention email failed', {
          legalInvoiceId: row.id,
          deliveryId: result.value.deliveryId,
          error: result.value.error,
        });
      }
    }
  } catch (error) {
    logger.warn('Legal invoice attention email failed', {
      legalInvoiceId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
