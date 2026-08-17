/**
 * Account Information — the tenant's business identity for invoices (#148).
 *
 * Distinct from Profile (the signed-in user's Clerk name/locale/password) and
 * from the bot's quoted address (#153). Official name, VAT, registered address
 * already live on onboarding; this mapper promotes them so the surface never
 * re-asks a fact we already have.
 */
import type { OnboardingCompany } from '../onboarding/onboarding-state';

export interface InvoiceAddress {
  street: string;
  postalCode: string;
  city: string;
  country: string;
}

export interface AccountInformation {
  officialBusinessName: string;
  vatNumber: string;
  contactPerson: string;
  invoiceAddress: InvoiceAddress;
  invoiceEmail: string;
  phone: string | null;
  vatVerified: boolean;
}

export interface AccountInformationSources {
  company?: OnboardingCompany | null;
  billingEmail?: string | null;
  tenantName?: string | null;
}

const emptyAddress = (): InvoiceAddress => ({
  street: '',
  postalCode: '',
  city: '',
  country: 'BE',
});

export function emptyAccountInformation(): AccountInformation {
  return {
    officialBusinessName: '',
    vatNumber: '',
    contactPerson: '',
    invoiceAddress: emptyAddress(),
    invoiceEmail: '',
    phone: null,
    vatVerified: false,
  };
}

/**
 * Prefill Account Information from facts already known.
 *
 * Onboarding wins for name / VAT / registered address / verified.
 * billingInfo.billingEmail fills invoice email when present.
 * tenant.name is a last-resort official-name fallback (the org name).
 * Contact person and phone have no home today — they stay empty.
 */
export function prefillAccountInformation(sources: AccountInformationSources): AccountInformation {
  const company = sources.company ?? null;
  const name = (company?.name ?? sources.tenantName ?? '').trim();
  return {
    officialBusinessName: name,
    vatNumber: (company?.vatNumber ?? '').trim(),
    contactPerson: '',
    invoiceAddress: {
      street: (company?.street ?? '').trim(),
      postalCode: (company?.postalCode ?? '').trim(),
      city: (company?.city ?? '').trim(),
      country: 'BE',
    },
    invoiceEmail: (sources.billingEmail ?? '').trim(),
    phone: null,
    vatVerified: company?.verified === true,
  };
}
