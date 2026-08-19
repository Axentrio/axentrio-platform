import { normalizeAccountVat, parseBelgianVat } from '../../integrations/company-lookup/vat-number';
import type {
  BillingValidationReason,
  BillingValidationResult,
  TenantInvoiceIdentity,
} from './types';

function trim(value: string | null | undefined): string {
  return (value ?? '').trim();
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
    const digitsOnly = rawVat.toUpperCase().replace(/[.\s-]/g, '');
    if (/^(BE)?\d+$/.test(digitsOnly)) {
      const belgian = parseBelgianVat(rawVat);
      if (belgian) vatNumber = belgian.vatNumber;
      else reasons.push('invalid_vat_number');
    } else {
      const parsed = normalizeAccountVat(rawVat);
      if (parsed.ok) vatNumber = parsed.value;
      else reasons.push('invalid_vat_number');
    }
  }

  const address = identity.invoiceAddress ?? null;
  const street = trim(address?.street);
  const postalCode = trim(address?.postalCode);
  const city = trim(address?.city);
  const country = (trim(address?.country) || trim(identity.operatingCountry) || '').toUpperCase() || null;
  const streetNumber = trim(address?.streetNumber) || undefined;
  const boxNumber = trim(address?.boxNumber) || undefined;

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
