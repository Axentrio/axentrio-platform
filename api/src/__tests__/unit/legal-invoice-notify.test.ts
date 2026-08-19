import { describe, expect, it } from 'vitest';
import {
  legalInvoiceAttentionDeepLink,
  needsLegalInvoiceAttention,
  renderLegalInvoiceAttentionEmail,
  uniqueSuperAdminRecipients,
} from '../../billing/legal-invoice/notify-attention';

describe('renderLegalInvoiceAttentionEmail', () => {
  it('states the Legal Invoice status, error, and admin link', () => {
    const rendered = renderLegalInvoiceAttentionEmail({
      tenantName: 'Example BV',
      documentKind: 'invoice',
      invoiceStatus: 'failed',
      lastError: 'billit_http_error',
      amountInclCents: 9074,
      currency: 'EUR',
      stripeInvoiceId: 'in_123',
      deepLink: 'http://localhost:4080/admin/legal-invoices',
    });

    expect(rendered.subject).toBe('Legal Invoice needs attention');
    expect(rendered.body).toContain('Example BV');
    expect(rendered.body).toContain('Status: failed');
    expect(rendered.body).toContain('Error: billit_http_error');
    expect(rendered.body).toContain('90.74 EUR');
    expect(rendered.body).toContain('in_123');
    expect(rendered.body).toContain('http://localhost:4080/admin/legal-invoices');
    expect(rendered.body).not.toContain('BE0400378485');
  });

  it('uses the Credit Note subject and refund id', () => {
    const rendered = renderLegalInvoiceAttentionEmail({
      tenantName: 'Example BV',
      documentKind: 'credit_note',
      invoiceStatus: 'manual_review',
      lastError: 'original_legal_invoice_missing',
      amountInclCents: 9074,
      currency: 'EUR',
      stripeRefundId: 're_9',
      deepLink: 'http://localhost:4080/admin/legal-invoices',
    });

    expect(rendered.subject).toBe('Credit Note needs attention');
    expect(rendered.body).toContain('re_9');
    expect(rendered.body).toContain('Status: manual_review');
  });

  it('escapes HTML in the tenant name and error', () => {
    const rendered = renderLegalInvoiceAttentionEmail({
      tenantName: '<script>alert(1)</script>',
      documentKind: 'invoice',
      invoiceStatus: 'failed',
      lastError: 'a <b>bad</b> error',
      amountInclCents: 0,
      currency: 'EUR',
      deepLink: 'http://localhost:4080/admin/legal-invoices',
    });

    expect(rendered.body).toContain('&lt;script&gt;');
    expect(rendered.body).not.toContain('<script>alert(1)</script>');
    expect(rendered.body).toContain('a &lt;b&gt;bad&lt;/b&gt; error');
  });
});

describe('needsLegalInvoiceAttention', () => {
  it('is true only for failed and manual_review', () => {
    expect(needsLegalInvoiceAttention({ invoiceStatus: 'failed' })).toBe(true);
    expect(needsLegalInvoiceAttention({ invoiceStatus: 'manual_review' })).toBe(true);
    expect(needsLegalInvoiceAttention({ invoiceStatus: 'sent' })).toBe(false);
    expect(needsLegalInvoiceAttention({ invoiceStatus: 'draft' })).toBe(false);
    expect(needsLegalInvoiceAttention({ invoiceStatus: 'created' })).toBe(false);
  });
});

describe('legalInvoiceAttentionDeepLink', () => {
  it('points at the Super Admin Legal Invoices page', () => {
    expect(legalInvoiceAttentionDeepLink()).toMatch(/\/admin\/legal-invoices$/);
  });

  it('adds the Legal Invoice id so the page can focus the row', () => {
    expect(legalInvoiceAttentionDeepLink('li-1')).toMatch(
      /\/admin\/legal-invoices\?invoice=li-1$/,
    );
  });
});

describe('uniqueSuperAdminRecipients', () => {
  it('keeps one row per email', () => {
    expect(
      uniqueSuperAdminRecipients([
        { id: 'u1', email: 'ops@axentrio.test' },
        { id: 'u2', email: 'OPS@axentrio.test' },
        { id: 'u3', email: 'other@axentrio.test' },
        { id: 'u4', email: '  ' },
      ]),
    ).toEqual([
      { id: 'u1', email: 'ops@axentrio.test' },
      { id: 'u3', email: 'other@axentrio.test' },
    ]);
  });
});
