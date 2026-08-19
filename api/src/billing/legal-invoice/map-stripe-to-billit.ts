import type {
  BillingValidationResult,
  BillitOrderLine,
  BillitOrderPayload,
  StripeInvoiceLike,
  StripeInvoiceLineLike,
} from './types';

const CENTS = 100;

export function shouldSkipZeroAmountInvoice(invoice: StripeInvoiceLike): boolean {
  const paid = invoice.amount_paid ?? 0;
  const total = invoice.total ?? paid;
  return paid === 0 && total === 0;
}

export function centsToEuros(cents: number): number {
  return Math.round(cents) / CENTS;
}

function vatPercentFromLine(line: StripeInvoiceLineLike): number {
  const modern = line.taxes?.[0]?.tax_rate_details?.percentage_decimal;
  if (modern != null && modern !== '') {
    const parsed = Number(modern);
    if (Number.isFinite(parsed)) return parsed;
  }
  const legacy = line.tax_amounts?.[0]?.tax_rate;
  if (legacy && typeof legacy === 'object' && legacy.percentage != null) {
    return Number(legacy.percentage);
  }
  const excl = line.amount_excluding_tax ?? null;
  const tax = line.taxes?.[0]?.amount ?? line.tax_amounts?.[0]?.amount ?? null;
  if (excl && excl !== 0 && tax != null) {
    return Math.round((Math.abs(tax) / Math.abs(excl)) * 10000) / 100;
  }
  return 0;
}

function exclCents(line: StripeInvoiceLineLike): number {
  if (typeof line.amount_excluding_tax === 'number') return line.amount_excluding_tax;
  const tax = line.taxes?.[0]?.amount ?? line.tax_amounts?.[0]?.amount ?? 0;
  return (line.amount ?? 0) - tax;
}

export function mapStripeLineToBillit(line: StripeInvoiceLineLike): BillitOrderLine {
  const quantityRaw = line.quantity && line.quantity !== 0 ? line.quantity : 1;
  const quantity = Math.abs(quantityRaw);
  const excl = exclCents(line);
  const unit = excl / quantity;
  return {
    Quantity: quantity,
    UnitPriceExcl: centsToEuros(unit),
    Description: (line.description ?? 'Axentrio subscription').trim() || 'Axentrio subscription',
    VATPercentage: vatPercentFromLine(line),
  };
}

export function billingPeriodLabel(invoice: StripeInvoiceLike): string {
  const startSec = invoice.period_start ?? invoice.created ?? null;
  if (!startSec) return '';
  return new Date(startSec * 1000).toLocaleString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function isoDate(unixSeconds: number | null | undefined): string {
  const sec = unixSeconds ?? Math.floor(Date.now() / 1000);
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function isoDateTime(unixSeconds: number | null | undefined): string {
  const sec = unixSeconds ?? Math.floor(Date.now() / 1000);
  return `${isoDate(sec)}T00:00:00`;
}

export function mapStripeInvoiceToBillitOrder(input: {
  invoice: StripeInvoiceLike;
  validation: BillingValidationResult;
  orderNumber: string;
  tenantId: string;
  orderType?: 'Invoice' | 'CreditNote';
  aboutInvoiceNumber?: string;
}): BillitOrderPayload {
  const { invoice, validation, orderNumber, tenantId } = input;
  if (!validation.ok || !validation.companyName || !validation.vatNumber || !validation.address) {
    throw new Error('cannot_map_invalid_billing_data');
  }
  const paidAt = invoice.status_transitions?.paid_at ?? invoice.created ?? null;
  const lines = (invoice.lines?.data ?? []).map(mapStripeLineToBillit);
  const orderLines =
    lines.length > 0
      ? lines
      : [
          {
            Quantity: 1,
            UnitPriceExcl: centsToEuros(invoice.total_excluding_tax ?? 0),
            Description: 'Axentrio subscription',
            VATPercentage: 21,
          },
        ];

  const payload: BillitOrderPayload = {
    OrderType: input.orderType ?? 'Invoice',
    OrderDirection: 'Income',
    OrderNumber: orderNumber,
    OrderDate: isoDate(paidAt),
    ExpiryDate: isoDate(paidAt),
    Paid: true,
    PaidDate: isoDateTime(paidAt),
    Currency: (invoice.currency ?? 'eur').toUpperCase(),
    OrderTitle: billingPeriodLabel(invoice) || undefined,
    ExternalProviderID: invoice.id,
    Customer: {
      Name: validation.companyName,
      VATNumber: validation.vatNumber,
      PartyType: 'Customer',
      Email: validation.email ?? undefined,
      Nr: tenantId,
      Addresses: [
        {
          AddressType: 'InvoiceAddress',
          Name: validation.companyName,
          Street: validation.address.street,
          StreetNumber: validation.address.streetNumber,
          Box: validation.address.boxNumber,
          Zipcode: validation.address.postalCode,
          City: validation.address.city,
          CountryCode: validation.address.country,
        },
      ],
    },
    OrderLines: orderLines,
  };
  if (input.aboutInvoiceNumber) {
    payload.AboutInvoiceNumber = input.aboutInvoiceNumber;
  }
  return payload;
}

export function totalsFromStripeInvoice(invoice: StripeInvoiceLike): {
  amountExclCents: number;
  vatAmountCents: number;
  amountInclCents: number;
} {
  const amountInclCents = invoice.amount_paid ?? invoice.total ?? 0;
  const amountExclCents = invoice.total_excluding_tax ?? amountInclCents;
  return {
    amountExclCents,
    vatAmountCents: amountInclCents - amountExclCents,
    amountInclCents,
  };
}
