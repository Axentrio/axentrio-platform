import { describe, it, expect } from 'vitest';
import {
  prefillAccountInformation,
  emptyAccountInformation,
} from '../../account/account-information';
import type { OnboardingCompany } from '../../onboarding/onboarding-state';

const COMPANY: OnboardingCompany = {
  vatNumber: 'BE0400378485',
  name: 'NV Colruyt Group',
  legalForm: 'NV',
  street: 'Edingensesteenweg 196',
  postalCode: '1500',
  city: 'Halle',
  verified: true,
};

describe('prefillAccountInformation', () => {
  it('promotes onboarding company facts rather than re-asking them', () => {
    const out = prefillAccountInformation({
      company: COMPANY,
      billingEmail: 'accounts@colruyt.be',
      tenantName: 'colruyt-org',
    });
    expect(out).toEqual({
      officialBusinessName: 'NV Colruyt Group',
      vatNumber: 'BE0400378485',
      contactPerson: '',
      invoiceAddress: {
        street: 'Edingensesteenweg 196',
        postalCode: '1500',
        city: 'Halle',
        country: 'BE',
      },
      invoiceEmail: 'accounts@colruyt.be',
      phone: null,
      vatVerified: true,
    });
  });

  it('falls back to the tenant name when onboarding never captured one', () => {
    const out = prefillAccountInformation({ tenantName: 'Aaquafin' });
    expect(out.officialBusinessName).toBe('Aaquafin');
    expect(out.vatNumber).toBe('');
    expect(out.vatVerified).toBe(false);
  });

  it('does not invent a contact person or phone', () => {
    const out = prefillAccountInformation({ company: COMPANY });
    expect(out.contactPerson).toBe('');
    expect(out.phone).toBeNull();
  });

  it('uses the VAT prefix as the invoice country', () => {
    const out = prefillAccountInformation({
      company: { ...COMPANY, vatNumber: 'NL123456789B01' },
    });
    expect(out.invoiceAddress.country).toBe('NL');
  });

  it('empty sources stay empty, not undefined', () => {
    expect(prefillAccountInformation({})).toEqual(emptyAccountInformation());
  });
});
