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

  it('accepts Belgian formats and keeps the existing canonical form', () => {
    for (const raw of ['BE 0123.456.789', '0123456789', 'BE0123456789']) {
      const r = accountInformationWriteSchema.safeParse({ ...valid, vatNumber: raw });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.vatNumber).toBe('BE0123456789');
    }
  });

  it('accepts EU VATs from NL, DE and FR', () => {
    expect(accountInformationWriteSchema.safeParse({ ...valid, vatNumber: 'NL123456789B01' }).success).toBe(true);
    expect(accountInformationWriteSchema.safeParse({ ...valid, vatNumber: 'DE123456789' }).success).toBe(true);
    const fr = accountInformationWriteSchema.safeParse({ ...valid, vatNumber: 'FR 40 303 265 045' });
    expect(fr.success).toBe(true);
    if (fr.success) expect(fr.data.vatNumber).toBe('FR40303265045');
  });

  it('rejects junk and anything longer than 16 characters after normalisation', () => {
    const junk = accountInformationWriteSchema.safeParse({ ...valid, vatNumber: '???' });
    expect(junk.success).toBe(false);
    if (!junk.success) {
      expect(junk.error.issues.some((i) => i.message === 'Invalid VAT number')).toBe(true);
    }

    const tooLong = accountInformationWriteSchema.safeParse({
      ...valid,
      vatNumber: 'NL123456789B01234',
    });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) {
      expect(tooLong.error.issues.some((i) => i.message === 'VAT number must be at most 16 characters')).toBe(true);
    }
  });

  it('rejects a malformed invoice email', () => {
    expect(accountInformationWriteSchema.safeParse({ ...valid, invoiceEmail: 'not-an-email' }).success).toBe(false);
  });

  it('accepts optional streetNumber / boxNumber and uppercases the country', () => {
    const r = accountInformationWriteSchema.safeParse({
      ...valid,
      invoiceAddress: { ...valid.invoiceAddress, streetNumber: '196', boxNumber: '2', country: 'be' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.invoiceAddress.streetNumber).toBe('196');
      expect(r.data.invoiceAddress.boxNumber).toBe('2');
      expect(r.data.invoiceAddress.country).toBe('BE');
    }
  });

  it('rejects a country that is not ISO alpha-2', () => {
    expect(
      accountInformationWriteSchema.safeParse({
        ...valid,
        invoiceAddress: { ...valid.invoiceAddress, country: 'België' },
      }).success,
    ).toBe(false);
  });
});
