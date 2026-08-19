import { AppDataSource } from '../../database/data-source';
import { LegalInvoice } from '../../database/entities/LegalInvoice';
import { Tenant } from '../../database/entities/Tenant';
import { TenantBillingAccount } from '../../database/entities/TenantBillingAccount';
import { logger } from '../../utils/logger';
import { getStripeClient } from '../providers/stripe';
import { BillitClientError, getBillitClient } from './billit-client';
import {
  mapStripeInvoiceToBillitOrder,
  shouldSkipZeroAmountInvoice,
  totalsFromStripeInvoice,
} from './map-stripe-to-billit';
import type { NormalizedEvent } from '../types';
import type { LegalInvoiceStatus, StripeInvoiceLike, StripeInvoiceLineLike } from './types';
import { notifyLegalInvoiceAttention } from './notify-attention';
import { validateTenantBillingData } from './validate';

function identityFromTenant(tenant: Tenant) {
  return {
    officialBusinessName: tenant.officialBusinessName,
    vatNumber: tenant.vatNumber,
    vatVerified: tenant.vatVerified,
    invoiceEmail: tenant.invoiceEmail,
    invoiceAddress: tenant.invoiceAddress,
    operatingCountry: tenant.operatingCountry,
  };
}

function readCustomerId(invoice: StripeInvoiceLike): string | null {
  if (typeof invoice.customer === 'string') return invoice.customer;
  if (invoice.customer && typeof invoice.customer === 'object' && invoice.customer.id) {
    return invoice.customer.id;
  }
  return null;
}

function readSubscriptionId(invoice: StripeInvoiceLike): string | null {
  if (typeof invoice.subscription === 'string') return invoice.subscription;
  if (invoice.subscription && typeof invoice.subscription === 'object' && invoice.subscription.id) {
    return invoice.subscription.id;
  }
  const parent = invoice.parent?.subscription_details?.subscription;
  if (typeof parent === 'string') return parent;
  if (parent && typeof parent === 'object' && parent.id) return parent.id;
  return null;
}

async function loadStripeInvoice(stripeInvoiceId: string): Promise<StripeInvoiceLike> {
  const stripe = getStripeClient();
  const invoice = await stripe.invoices.retrieve(stripeInvoiceId, {
    expand: ['lines'],
  });
  const asLike = invoice as unknown as StripeInvoiceLike;
  if (invoice.lines?.has_more) {
    const extra = await stripe.invoices.listLineItems(stripeInvoiceId, { limit: 100 });
    asLike.lines = { data: extra.data as StripeInvoiceLineLike[], has_more: extra.has_more };
  }
  return asLike;
}

const TERMINAL: LegalInvoiceStatus[] = ['sent', 'credited'];

export function isRetryableLegalInvoice(row: {
  invoiceStatus: LegalInvoiceStatus;
  peppolStatus: string;
  lastError?: string | null;
}): boolean {
  if (TERMINAL.includes(row.invoiceStatus)) return false;
  if (row.invoiceStatus === 'created' && (row.peppolStatus === 'not_required' || row.peppolStatus === 'sent')) {
    return false;
  }
  if (row.invoiceStatus === 'manual_review' && row.lastError !== 'peppol_not_available') {
    return false;
  }
  return true;
}

function errorMessage(err: unknown): string {
  if (err instanceof BillitClientError) return err.code;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function persistLegalInvoice(row: LegalInvoice): Promise<LegalInvoice> {
  const saved = await AppDataSource.getRepository(LegalInvoice).save(row);
  await notifyLegalInvoiceAttention(saved);
  return saved;
}

export async function processPaidStripeInvoice(input: {
  tenantId: string;
  stripeInvoiceId: string;
}): Promise<{ outcome: string; legalInvoiceId?: string }> {
  const tenant = await AppDataSource.getRepository(Tenant).findOneBy({ id: input.tenantId });
  if (!tenant) {
    logger.warn('Legal invoice skipped: tenant missing', input);
    return { outcome: 'tenant_missing' };
  }

  let invoice: StripeInvoiceLike;
  try {
    invoice = await loadStripeInvoice(input.stripeInvoiceId);
  } catch (err) {
    logger.error('Legal invoice: Stripe retrieve failed', {
      ...input,
      error: err instanceof Error ? err.message : String(err),
    });
    const repo = AppDataSource.getRepository(LegalInvoice);
    let row = await repo.findOne({
      where: { tenantId: input.tenantId, stripeInvoiceId: input.stripeInvoiceId, documentKind: 'invoice' },
    });
    if (!row) {
      row = repo.create({
        tenantId: input.tenantId,
        documentKind: 'invoice',
        stripeInvoiceId: input.stripeInvoiceId,
        invoiceStatus: 'failed',
        peppolStatus: 'pending',
        paymentStatus: 'paid',
        peppolRequired: false,
        currency: 'EUR',
        amountExclCents: 0,
        vatAmountCents: 0,
        amountInclCents: 0,
        reviewReasons: [],
        retryCount: 0,
      });
    } else {
      row.retryCount += 1;
    }
    row.lastError = 'stripe_retrieve_failed';
    if (row.invoiceStatus !== 'sent' && row.invoiceStatus !== 'credited') {
      row.invoiceStatus = 'failed';
    }
    await persistLegalInvoice(row);
    return { outcome: 'stripe_retrieve_failed', legalInvoiceId: row.id };
  }

  if (shouldSkipZeroAmountInvoice(invoice)) {
    return { outcome: 'skipped_zero_amount' };
  }

  const repo = AppDataSource.getRepository(LegalInvoice);
  let row = await repo.findOne({
    where: { tenantId: input.tenantId, stripeInvoiceId: input.stripeInvoiceId, documentKind: 'invoice' },
  });
  if (row && TERMINAL.includes(row.invoiceStatus)) {
    return { outcome: 'already_final', legalInvoiceId: row.id };
  }

  const validation = validateTenantBillingData(identityFromTenant(tenant));
  const totals = totalsFromStripeInvoice(invoice);
  const fields = {
    stripeCustomerId: readCustomerId(invoice),
    stripeSubscriptionId: readSubscriptionId(invoice),
    paymentStatus: 'paid' as const,
    peppolRequired: validation.peppolRequired,
    currency: (invoice.currency ?? 'eur').toUpperCase(),
    ...totals,
    reviewReasons: validation.reasons,
  };

  if (!row) {
    row = repo.create({
      tenantId: input.tenantId,
      documentKind: 'invoice',
      stripeInvoiceId: input.stripeInvoiceId,
      invoiceStatus: 'draft',
      peppolStatus: validation.peppolRequired ? 'pending' : 'not_required',
      retryCount: 0,
      ...fields,
    });
  } else {
    Object.assign(row, fields);
    row.retryCount += 1;
  }

  if (!validation.ok) {
    row.invoiceStatus = 'manual_review';
    row.peppolStatus = validation.peppolRequired ? 'pending' : 'not_required';
    row.lastError = validation.reasons.join(',');
    await persistLegalInvoice(row);
    return { outcome: 'manual_review', legalInvoiceId: row.id };
  }

  const billit = getBillitClient();
  if (!billit.isConfigured()) {
    row.invoiceStatus = 'draft';
    row.lastError = 'billit_not_configured';
    await persistLegalInvoice(row);
    return { outcome: 'billit_not_configured', legalInvoiceId: row.id };
  }

  try {
    if (!row.billitInvoiceNumber) {
      row.billitInvoiceNumber = await billit.consumeNextNumber('invoice');
      await persistLegalInvoice(row);
    }

    if (!row.billitOrderId) {
      try {
        const created = await billit.createOrder(
          mapStripeInvoiceToBillitOrder({
            invoice,
            validation,
            orderNumber: row.billitInvoiceNumber,
            tenantId: tenant.id,
          }),
          input.stripeInvoiceId,
        );
        row.billitOrderId = created.orderId;
        if (created.orderNumber) row.billitInvoiceNumber = created.orderNumber;
      } catch (err) {
        if (err instanceof BillitClientError && err.code === 'billit_idempotent_replay') {
          row.lastError = 'billit_idempotent_replay';
          row.invoiceStatus = row.billitOrderId ? 'created' : 'failed';
          await persistLegalInvoice(row);
          if (!row.billitOrderId) {
            return { outcome: 'failed', legalInvoiceId: row.id };
          }
        } else {
          throw err;
        }
      }
    }

    row.invoiceStatus = 'created';
    row.lastError = null;

    if (!validation.peppolRequired) {
      row.peppolStatus = 'not_required';
      await persistLegalInvoice(row);
      return { outcome: 'created_peppol_not_required', legalInvoiceId: row.id };
    }

    const peppol = await billit.lookupPeppol(validation.vatNumber!);
    const canReceiveInvoice = peppol.registered && peppol.documentTypes.includes('BISv3Invoice');
    if (!canReceiveInvoice) {
      row.peppolStatus = 'not_available';
      row.invoiceStatus = 'manual_review';
      row.lastError = 'peppol_not_available';
      await persistLegalInvoice(row);
      return { outcome: 'peppol_not_available', legalInvoiceId: row.id };
    }

    await billit.sendOrders([row.billitOrderId], 'Peppol');
    row.peppolStatus = 'sent';
    row.invoiceStatus = 'sent';
    await persistLegalInvoice(row);
    return { outcome: 'sent', legalInvoiceId: row.id };
  } catch (err) {
    const message = errorMessage(err);
    logger.error('Legal invoice Billit step failed', {
      tenantId: input.tenantId,
      stripeInvoiceId: input.stripeInvoiceId,
      legalInvoiceId: row.id,
      error: message,
    });
    if (row.billitOrderId) {
      row.invoiceStatus = 'created';
      row.peppolStatus = validation.peppolRequired ? 'failed' : row.peppolStatus;
    } else {
      row.invoiceStatus = 'failed';
    }
    row.lastError = message;
    try {
      await persistLegalInvoice(row);
    } catch (saveErr) {
      logger.error('Legal invoice persist failed after Billit error', {
        legalInvoiceId: row.id,
        error: saveErr instanceof Error ? saveErr.message : String(saveErr),
      });
    }
    return { outcome: 'failed', legalInvoiceId: row.id };
  }
}

export async function processStripeRefund(input: {
  tenantId: string;
  stripeInvoiceId?: string | null;
  stripeRefundId: string;
  stripeChargeId?: string | null;
  amountRefundedCents: number;
}): Promise<{ outcome: string; legalInvoiceId?: string }> {
  const repo = AppDataSource.getRepository(LegalInvoice);
  const existing = await repo.findOne({ where: { stripeRefundId: input.stripeRefundId } });
  if (existing && !isRetryableLegalInvoice(existing)) {
    return { outcome: 'already_recorded', legalInvoiceId: existing.id };
  }

  const original = input.stripeInvoiceId
    ? await repo.findOne({
        where: {
          tenantId: input.tenantId,
          stripeInvoiceId: input.stripeInvoiceId,
          documentKind: 'invoice',
        },
      })
    : null;

  const tenant = await AppDataSource.getRepository(Tenant).findOneBy({ id: input.tenantId });
  if (!tenant) return { outcome: 'tenant_missing' };

  const validation = validateTenantBillingData(identityFromTenant(tenant));
  const credit =
    existing ??
    repo.create({
      tenantId: input.tenantId,
      documentKind: 'credit_note',
      stripeInvoiceId: input.stripeInvoiceId ?? null,
      stripeRefundId: input.stripeRefundId,
      stripeChargeId: input.stripeChargeId ?? null,
      creditedFromId: original?.id ?? null,
      paymentStatus: 'refunded',
      invoiceStatus: 'draft',
      peppolStatus: validation.peppolRequired ? 'pending' : 'not_required',
      peppolRequired: validation.peppolRequired,
      currency: original?.currency ?? 'EUR',
      amountExclCents: input.amountRefundedCents,
      vatAmountCents: 0,
      amountInclCents: input.amountRefundedCents,
      reviewReasons: validation.ok ? [] : validation.reasons,
      retryCount: 0,
    });
  if (existing) {
    credit.retryCount += 1;
    credit.reviewReasons = validation.ok ? [] : validation.reasons;
    credit.creditedFromId = original?.id ?? credit.creditedFromId;
  }

  if (!original || !original.billitInvoiceNumber) {
    credit.invoiceStatus = 'manual_review';
    credit.lastError = original ? 'original_missing_billit_number' : 'original_legal_invoice_missing';
    await persistLegalInvoice(credit);
    return { outcome: 'manual_review', legalInvoiceId: credit.id };
  }

  if (!validation.ok) {
    credit.invoiceStatus = 'manual_review';
    credit.lastError = validation.reasons.join(',');
    await persistLegalInvoice(credit);
    return { outcome: 'manual_review', legalInvoiceId: credit.id };
  }

  const billit = getBillitClient();
  if (!billit.isConfigured()) {
    credit.invoiceStatus = 'draft';
    credit.lastError = 'billit_not_configured';
    await persistLegalInvoice(credit);
    return { outcome: 'billit_not_configured', legalInvoiceId: credit.id };
  }

  try {
    if (!credit.billitInvoiceNumber) {
      credit.billitInvoiceNumber = await billit.consumeNextNumber('credit_note');
      await persistLegalInvoice(credit);
    }
    if (!credit.billitOrderId) {
      const created = await billit.createOrder(
        mapStripeInvoiceToBillitOrder({
          invoice: {
            id: input.stripeRefundId,
            amount_paid: input.amountRefundedCents,
            total: input.amountRefundedCents,
            total_excluding_tax: input.amountRefundedCents,
            currency: credit.currency.toLowerCase(),
            created: Math.floor(Date.now() / 1000),
            lines: {
              data: [
                {
                  description: `Credit note for ${original.billitInvoiceNumber}`,
                  quantity: 1,
                  amount: input.amountRefundedCents,
                  amount_excluding_tax: input.amountRefundedCents,
                },
              ],
            },
          },
          validation,
          orderNumber: credit.billitInvoiceNumber,
          tenantId: tenant.id,
          orderType: 'CreditNote',
          aboutInvoiceNumber: original.billitInvoiceNumber,
        }),
        input.stripeRefundId,
      );
      credit.billitOrderId = created.orderId;
    }
    credit.invoiceStatus = 'created';
    credit.paymentStatus = 'refunded';

    if (validation.peppolRequired) {
      const peppol = await billit.lookupPeppol(validation.vatNumber!);
      if (peppol.registered && peppol.documentTypes.includes('BISv3CreditNote')) {
        await billit.sendOrders([credit.billitOrderId], 'Peppol');
        credit.peppolStatus = 'sent';
        credit.invoiceStatus = 'sent';
        credit.lastError = null;
      } else {
        credit.peppolStatus = 'not_available';
        credit.invoiceStatus = 'manual_review';
        credit.lastError = 'peppol_not_available';
      }
    } else {
      credit.peppolStatus = 'not_required';
    }

    if (original.amountInclCents > 0 && input.amountRefundedCents >= original.amountInclCents) {
      original.invoiceStatus = 'credited';
      original.paymentStatus = 'refunded';
      await persistLegalInvoice(original);
    }
    await persistLegalInvoice(credit);
    return { outcome: credit.invoiceStatus === 'sent' ? 'sent' : credit.invoiceStatus, legalInvoiceId: credit.id };
  } catch (err) {
    const message = errorMessage(err);
    logger.error('Credit note Billit step failed', {
      tenantId: input.tenantId,
      stripeRefundId: input.stripeRefundId,
      legalInvoiceId: credit.id,
      error: message,
    });
    if (credit.billitOrderId) {
      credit.invoiceStatus = 'created';
      credit.peppolStatus = validation.peppolRequired ? 'failed' : credit.peppolStatus;
    } else {
      credit.invoiceStatus = 'failed';
    }
    credit.lastError = message;
    try {
      await persistLegalInvoice(credit);
    } catch (saveErr) {
      logger.error('Credit note persist failed after Billit error', {
        legalInvoiceId: credit.id,
        error: saveErr instanceof Error ? saveErr.message : String(saveErr),
      });
    }
    return { outcome: 'failed', legalInvoiceId: credit.id };
  }
}

export async function retryWaitingLegalInvoices(): Promise<{
  attempted: number;
  outcomes: Array<{ id: string; outcome: string }>;
}> {
  const candidates = await AppDataSource.getRepository(LegalInvoice).find({
    order: { createdAt: 'ASC' },
    take: 200,
  });
  const waiting = candidates.filter(isRetryableLegalInvoice).slice(0, 100);
  const outcomes: Array<{ id: string; outcome: string }> = [];
  for (const row of waiting) {
    const result = await retryLegalInvoice(row.id);
    outcomes.push({ id: row.id, outcome: result.outcome });
  }
  return { attempted: waiting.length, outcomes };
}

export async function retryLegalInvoice(legalInvoiceId: string): Promise<{ outcome: string }> {
  const repo = AppDataSource.getRepository(LegalInvoice);
  const row = await repo.findOneBy({ id: legalInvoiceId });
  if (!row) return { outcome: 'missing' };
  if (!isRetryableLegalInvoice(row)) return { outcome: 'already_final' };
  if (row.documentKind === 'credit_note') {
    if (!row.stripeRefundId) return { outcome: 'missing_refund_id' };
    return processStripeRefund({
      tenantId: row.tenantId,
      stripeInvoiceId: row.stripeInvoiceId,
      stripeRefundId: row.stripeRefundId,
      stripeChargeId: row.stripeChargeId,
      amountRefundedCents: row.amountInclCents,
    });
  }
  if (!row.stripeInvoiceId) return { outcome: 'missing_stripe_invoice' };
  if (row.invoiceStatus === 'failed' || row.invoiceStatus === 'manual_review') {
    row.invoiceStatus = 'draft';
    await persistLegalInvoice(row);
  }
  return processPaidStripeInvoice({
    tenantId: row.tenantId,
    stripeInvoiceId: row.stripeInvoiceId,
  });
}

export async function listLegalInvoicesForTenant(tenantId: string, limit = 20): Promise<LegalInvoice[]> {
  return AppDataSource.getRepository(LegalInvoice).find({
    where: { tenantId },
    order: { createdAt: 'DESC' },
    take: limit,
  });
}

export function toPublicLegalInvoice(row: LegalInvoice, tenantName?: string | null) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantName: tenantName ?? null,
    documentKind: row.documentKind,
    stripeInvoiceId: row.stripeInvoiceId,
    stripeRefundId: row.stripeRefundId,
    billitInvoiceId: row.billitOrderId,
    billitInvoiceNumber: row.billitInvoiceNumber,
    paymentStatus: row.paymentStatus,
    invoiceStatus: row.invoiceStatus,
    peppolStatus: row.peppolStatus,
    peppolRequired: row.peppolRequired,
    currency: row.currency,
    amountExclCents: row.amountExclCents,
    vatAmountCents: row.vatAmountCents,
    amountInclCents: row.amountInclCents,
    reviewReasons: row.reviewReasons,
    lastError: row.lastError,
    retryable: isRetryableLegalInvoice(row),
    createdAt: row.createdAt,
  };
}

export async function listLegalInvoicesForAdmin(limit = 100): Promise<{
  invoices: ReturnType<typeof toPublicLegalInvoice>[];
  attentionCount: number;
  total: number;
}> {
  const rows = await AppDataSource.getRepository(LegalInvoice).find({
    order: { createdAt: 'DESC' },
    take: Math.min(Math.max(limit, 1), 200),
  });
  const tenantIds = [...new Set(rows.map((row) => row.tenantId))];
  const tenants =
    tenantIds.length === 0
      ? []
      : await AppDataSource.getRepository(Tenant)
          .createQueryBuilder('t')
          .select(['t.id', 't.name'])
          .where('t.id IN (:...ids)', { ids: tenantIds })
          .getMany();
  const names = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
  const invoices = rows.map((row) => toPublicLegalInvoice(row, names.get(row.tenantId) ?? null));
  return {
    invoices,
    attentionCount: rows.filter(isRetryableLegalInvoice).length,
    total: rows.length,
  };
}

async function resolveTenantId(event: NormalizedEvent): Promise<string | null> {
  const row = await AppDataSource.getRepository(TenantBillingAccount).findOne({
    where: event.subscriptionId
      ? { provider: 'stripe', subscriptionId: event.subscriptionId }
      : { provider: 'stripe', customerId: event.customerId },
  });
  if (row) return row.tenantId;
  if (event.customerId) {
    const byCustomer = await AppDataSource.getRepository(TenantBillingAccount).findOne({
      where: { provider: 'stripe', customerId: event.customerId },
    });
    return byCustomer?.tenantId ?? null;
  }
  return null;
}

function invoiceIdFromEvent(event: NormalizedEvent): string | null {
  if (event.invoiceId) return event.invoiceId;
  const raw = event.raw as { data?: { object?: { id?: string; invoice?: string | { id?: string } } } } | undefined;
  const obj = raw?.data?.object;
  if (!obj) return null;
  if (event.type === 'invoice.paid' && typeof obj.id === 'string') return obj.id;
  if (typeof obj.invoice === 'string') return obj.invoice;
  if (obj.invoice && typeof obj.invoice === 'object' && obj.invoice.id) return obj.invoice.id;
  return null;
}

export async function scheduleFromInvoicePaid(event: NormalizedEvent): Promise<void> {
  const stripeInvoiceId = invoiceIdFromEvent(event);
  if (!stripeInvoiceId) {
    logger.warn('Legal invoice skipped: no Stripe invoice id on invoice.paid');
    return;
  }
  const tenantId = await resolveTenantId(event);
  if (!tenantId) {
    logger.warn('Legal invoice skipped: no Tenant for invoice.paid', { stripeInvoiceId });
    return;
  }
  try {
    const result = await processPaidStripeInvoice({ tenantId, stripeInvoiceId });
    logger.info('Legal invoice processed', { tenantId, stripeInvoiceId, outcome: result.outcome });
  } catch (err) {
    logger.error('Legal invoice processing threw', {
      tenantId,
      stripeInvoiceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function scheduleFromRefund(event: NormalizedEvent): Promise<void> {
  const raw = event.raw as {
    data?: {
      object?: {
        id?: string;
        invoice?: string | { id?: string };
        amount_refunded?: number;
        refunds?: { data?: Array<{ id?: string; amount?: number }> };
      };
    };
  };
  const charge = raw?.data?.object;
  const refunds = charge?.refunds?.data ?? [];
  const latest = refunds[refunds.length - 1];
  const stripeRefundId = event.refundId ?? latest?.id;
  if (!stripeRefundId) {
    logger.warn('Credit note skipped: no Stripe refund id');
    return;
  }
  const tenantId = await resolveTenantId(event);
  if (!tenantId) {
    logger.warn('Credit note skipped: no Tenant for refund', { stripeRefundId });
    return;
  }
  try {
    const result = await processStripeRefund({
      tenantId,
      stripeInvoiceId: invoiceIdFromEvent(event),
      stripeRefundId,
      stripeChargeId: typeof charge?.id === 'string' ? charge.id : null,
      amountRefundedCents: event.refundAmountCents ?? latest?.amount ?? charge?.amount_refunded ?? 0,
    });
    logger.info('Credit note processed', { tenantId, stripeRefundId, outcome: result.outcome });
  } catch (err) {
    logger.error('Credit note processing threw', {
      tenantId,
      stripeRefundId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
