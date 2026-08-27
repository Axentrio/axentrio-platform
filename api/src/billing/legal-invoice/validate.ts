import { normalizeAccountVat, parseBelgianVat } from '../../integrations/company-lookup/vat-number';
import type {
  BillingValidationReason,
  BillingValidationResult,
  TenantInvoiceIdentity,
} from './types';

function trim(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function resolveVatNumber(rawVat: string): { vatNumber: string | null; invalid: boolean } {
  const digitsOnly = rawVat.toUpperCase().replace(/[.\s-]/g, '');
  if (/^(BE)?\d+$/.test(digitsOnly)) {
    const belgian = parseBelgianVat(rawVat);
    if (belgian) return { vatNumber: belgian.vatNumber, invalid: false };
    return { vatNumber: null, invalid: true };
  }
  const parsed = normalizeAccountVat(rawVat);
  if (parsed.ok) return { vatNumber: parsed.value, invalid: false };
  return { vatNumber: null, invalid: true };
}

type InvoiceAddressParts = {
  street: string;
  postalCode: string;
  city: string;
  country: string | null;
  streetNumber: string | undefined;
  boxNumber: string | undefined;
};

function resolveAddressParts(identity: TenantInvoiceIdentity): InvoiceAddressParts {
  const address = identity.invoiceAddress ?? null;
  const country =
    (trim(address?.country) || trim(identity.operatingCountry) || '').toUpperCase() || null;
  return {
    street: trim(address?.street),
    postalCode: trim(address?.postalCode),
    city: trim(address?.city),
    country,
    streetNumber: trim(address?.streetNumber) || undefined,
    boxNumber: trim(address?.boxNumber) || undefined,
  };
}

export function validateTenantBillingData(
  identity: TenantInvoiceIdentity,
): BillingValidationResult {
  const reasons: BillingValidationReason[] = [];
  const companyName = trim(identity.officialBusinessName) || null;
  if (!companyName) reasons.push('missing_company_name');

  const rawVat = trim(identity.vatNumber);
  if (!rawVat) {
    reasons.push('missing_vat_number');
    reasons.push('not_b2b');
  }

  let vatNumber: string | null = null;
  if (rawVat) {
    const resolved = resolveVatNumber(rawVat);
    vatNumber = resolved.vatNumber;
    if (resolved.invalid) reasons.push('invalid_vat_number');
  }

  const { street, postalCode, city, country, streetNumber, boxNumber } =
    resolveAddressParts(identity);

  if (!country) reasons.push('missing_country');
  if (!street || !postalCode || !city) reasons.push('incomplete_address');

  const peppolRequired = Boolean(country === 'BE' && vatNumber);

  return {
    ok: reasons.length === 0,
    reasons,
    peppolRequired,
    country,
    vatNumber,
    companyName,
    email: trim(identity.invoiceEmail) || null,
    address:
      street && postalCode && city && country
        ? { street, streetNumber, boxNumber, postalCode, city, country }
        : null,
  };
}
