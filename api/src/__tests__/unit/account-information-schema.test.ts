import { describe, it, expect } from 'vitest';
import { accountInformationWriteSchema } from '../../schemas/account-information.schema';

const valid = {
  officialBusinessName: 'NV Colruyt Group',
  vatNumber: 'BE 0400.378.485',
  contactPerson: 'Jan Janssens',
  invoiceAddress: {
    street: 'Edingensesteenweg 196',
    postalCode: '1500',
    city: 'Halle',
    country: 'BE',
  },
  invoiceEmail: 'accounts@colruyt.be',
  phone: '+32 2 363 55 45',
};

describe('accountInformationWriteSchema', () => {
  it('accepts a complete payload and normalises the VAT number', () => {
    const r = accountInformationWriteSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.vatNumber).toBe('BE0400378485');
      expect(r.data.phone).toBe('+32 2 363 55 45');
    }
  });

  it('treats a blank phone as null (optional)', () => {
    const r = accountInformationWriteSchema.safeParse({ ...valid, phone: '   ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phone).toBeNull();
  });

  it('rejects a missing official name / contact / invoice email / address', () => {
    for (const key of ['officialBusinessName', 'contactPerson', 'invoiceEmail'] as const) {
      const r = accountInformationWriteSchema.safeParse({ ...valid, [key]: '' });
      expect(r.success).toBe(false);
    }
    const noStreet = accountInformationWriteSchema.safeParse({
      ...valid,
      invoiceAddress: { ...valid.invoiceAddress, street: '' },
    });
    expect(noStreet.success).toBe(false);
  });

  it('rejects a non-Belgian or malformed VAT', () => {
    expect(accountInformationWriteSchema.safeParse({ ...valid, vatNumber: 'FR123' }).success).toBe(false);
    expect(accountInformationWriteSchema.safeParse({ ...valid, vatNumber: 'not-a-vat' }).success).toBe(false);
  });

  it('rejects a malformed invoice email', () => {
    expect(accountInformationWriteSchema.safeParse({ ...valid, invoiceEmail: 'not-an-email' }).success).toBe(false);
  });
});
