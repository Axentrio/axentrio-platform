import { describe, expect, it } from 'vitest';
import { validateTenantBillingData } from '../../billing/legal-invoice/validate';
import type { TenantInvoiceIdentity } from '../../billing/legal-invoice/types';

const COMPLETE_BE: TenantInvoiceIdentity = {
  officialBusinessName: 'Example BV',
  vatNumber: 'BE0400378485',
  vatVerified: true,
  invoiceEmail: 'billing@example.com',
  invoiceAddress: {
    street: 'Example Street',
    streetNumber: '1',
    postalCode: '2000',
    city: 'Antwerp',
    country: 'BE',
  },
  operatingCountry: 'BE',
};

describe('validateTenantBillingData', () => {
  it('accepts a complete Belgian B2B Tenant and requires Peppol', () => {
    const result = validateTenantBillingData(COMPLETE_BE);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.peppolRequired).toBe(true);
    expect(result.vatNumber).toBe('BE0400378485');
    expect(result.country).toBe('BE');
  });

  it('marks missing company name for manual review', () => {
    const result = validateTenantBillingData({ ...COMPLETE_BE, officialBusinessName: '  ' });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('missing_company_name');
  });

  it('marks missing VAT for manual review', () => {
    const result = validateTenantBillingData({ ...COMPLETE_BE, vatNumber: null });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('missing_vat_number');
    expect(result.peppolRequired).toBe(false);
  });

  it('marks an invalid Belgian VAT for manual review', () => {
    const result = validateTenantBillingData({ ...COMPLETE_BE, vatNumber: 'BE999' });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('invalid_vat_number');
  });

  it('marks an incomplete address for manual review', () => {
    const result = validateTenantBillingData({
      ...COMPLETE_BE,
      invoiceAddress: { street: 'Example Street', postalCode: '', city: 'Antwerp', country: 'BE' },
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('incomplete_address');
  });

  it('does not require Peppol for a non-Belgian Tenant', () => {
    const result = validateTenantBillingData({
      ...COMPLETE_BE,
      vatNumber: 'NL123456789B01',
      invoiceAddress: {
        street: 'Keizersgracht',
        streetNumber: '1',
        postalCode: '1015 CJ',
        city: 'Amsterdam',
        country: 'NL',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.peppolRequired).toBe(false);
  });
});
