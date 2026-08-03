/**
 * VAT-based company lookup.
 *
 * Two things are load-bearing and both are about failure. First, the number a customer
 * types is never the number a spec imagines — this is the first field of signup and a
 * format quibble is a terrible first impression. Second, VIES is a government register
 * measured at 3–8 seconds, so being slow, rate-limited or down is a NORMAL Tuesday, and
 * none of those may stop someone signing up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const axiosGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get: axiosGet }, get: axiosGet }));

import {
  lookupCompanyByVat,
  parseViesAddress,
} from '../../integrations/company-lookup/company-lookup.service';
import { parseBelgianVat, splitLegalForm, formatEnterpriseNumber } from '../../integrations/company-lookup/vat-number';

/** A real VIES payload, copied from the live service. */
const COLRUYT = {
  isValid: true,
  name: 'NV Colruyt Group',
  address: 'Edingensesteenweg 196\n1500 Halle',
};

beforeEach(() => {
  axiosGet.mockReset();
});

describe('parseBelgianVat — accept every way a human writes it', () => {
  it('accepts the formats printed on real invoices and letterheads', () => {
    for (const raw of [
      'BE0400378485',
      'BE 0400.378.485',
      'be 0400 378 485',
      '0400.378.485',
      '0400378485',
    ]) {
      expect(parseBelgianVat(raw)?.enterpriseNumber).toBe('0400378485');
    }
  });

  it('accepts the pre-2005 nine-digit form still printed on old paperwork', () => {
    // Same company, written before the leading zero was mandatory.
    expect(parseBelgianVat('400378485')?.enterpriseNumber).toBe('0400378485');
  });

  it('refuses what is not a Belgian enterprise number', () => {
    // Guessing here costs a pointless multi-second lookup, so the bar is exactness.
    expect(parseBelgianVat('')).toBeNull();
    expect(parseBelgianVat(null)).toBeNull();
    expect(parseBelgianVat('abc')).toBeNull();
    expect(parseBelgianVat('12345')).toBeNull();
    expect(parseBelgianVat('9400378485')).toBeNull(); // enterprise numbers start 0 or 1
    expect(parseBelgianVat('04003784850')).toBeNull(); // eleven digits
  });

  it('formats back to the form printed on invoices', () => {
    expect(formatEnterpriseNumber('0400378485')).toBe('0400.378.485');
  });
});

describe('splitLegalForm — derived from convention, never invented', () => {
  it('splits the forms the register actually returns', () => {
    expect(splitLegalForm('NV Colruyt Group')).toEqual({ name: 'Colruyt Group', legalForm: 'NV' });
    expect(splitLegalForm('SA BNP Paribas Fortis')).toEqual({
      name: 'BNP Paribas Fortis',
      legalForm: 'SA',
    });
  });

  it('prefers the longer form so BV cannot swallow BVBA', () => {
    expect(splitLegalForm('BVBA Janssens')).toEqual({ name: 'Janssens', legalForm: 'BVBA' });
  });

  it('does not find a legal form inside an ordinary word', () => {
    // "SANITAIR JANSSENS" starts with the letters S and A and is not an SA.
    expect(splitLegalForm('SANITAIR JANSSENS')).toEqual({
      name: 'SANITAIR JANSSENS',
      legalForm: null,
    });
  });

  it('returns null rather than guessing when the name carries no form', () => {
    // An empty field the customer can fill beats a confident guess about their legal status.
    expect(splitLegalForm('Loodgieterij De Vries')).toEqual({
      name: 'Loodgieterij De Vries',
      legalForm: null,
    });
  });
});

describe('parseViesAddress', () => {
  it('splits street from the Belgian four-digit postcode and city', () => {
    expect(parseViesAddress('Edingensesteenweg 196\n1500 Halle')).toEqual({
      street: 'Edingensesteenweg 196',
      postalCode: '1500',
      city: 'Halle',
    });
  });

  it('leaves an unexpected shape obviously partial rather than force-fitting it', () => {
    // A half-parsed address that LOOKS complete is worse than one the customer can see
    // is incomplete and correct.
    expect(parseViesAddress('Somewhere odd')).toEqual({
      street: 'Somewhere odd',
      postalCode: null,
      city: null,
    });
    expect(parseViesAddress('---')).toEqual({ street: null, postalCode: null, city: null });
  });
});

describe('lookupCompanyByVat', () => {
  it('returns the company for a valid number', async () => {
    axiosGet.mockResolvedValue({ data: COLRUYT });
    const r = await lookupCompanyByVat('BE 0400.378.485');
    expect(r.status).toBe('found');
    expect(r.company).toMatchObject({
      vatNumber: 'BE0400378485',
      name: 'Colruyt Group',
      legalForm: 'NV',
      postalCode: '1500',
      city: 'Halle',
      countryCode: 'BE',
    });
  });

  it('reports a number the register does not recognise as not_found, not an error', async () => {
    // This is the fake/ceased-business check: a company that stopped trading loses its
    // VAT registration and comes back invalid.
    axiosGet.mockResolvedValue({ data: { isValid: false, name: '---', address: '---' } });
    const r = await lookupCompanyByVat('0999999999');
    expect(r).toMatchObject({ status: 'not_found', company: null });
  });

  it('never calls the register for something that cannot be a VAT number', async () => {
    const r = await lookupCompanyByVat('hello');
    expect(r.status).toBe('invalid_format');
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('degrades to unavailable when the register is down, and never throws', async () => {
    // The explicit product rule: losing a signup to someone else's downtime is far
    // worse than an unverified company record.
    axiosGet.mockRejectedValue(new Error('ETIMEDOUT'));
    const r = await lookupCompanyByVat('0400378485');
    expect(r).toMatchObject({ status: 'unavailable', company: null });
  });

  it('times out well before a person would give up', async () => {
    axiosGet.mockResolvedValue({ data: COLRUYT });
    await lookupCompanyByVat('0400378485');
    expect(axiosGet.mock.calls[0][1]).toMatchObject({ timeout: 10_000 });
  });
});

describe('lookupCompanyByVat — caching, because the register takes seconds', () => {
  const redis = () => {
    const store = new Map<string, string>();
    return {
      store,
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    };
  };

  it('serves a repeat lookup from cache without touching the register', async () => {
    const r = redis();
    axiosGet.mockResolvedValue({ data: COLRUYT });

    const first = await lookupCompanyByVat('0400378485', { redis: r as never });
    const second = await lookupCompanyByVat('BE 0400.378.485', { redis: r as never });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.company?.name).toBe('Colruyt Group');
    expect(axiosGet).toHaveBeenCalledTimes(1); // the second never went out
  });

  it('caches a negative answer too', async () => {
    // A typo'd number would otherwise cost a multi-second round trip on every retry.
    const r = redis();
    axiosGet.mockResolvedValue({ data: { isValid: false } });
    await lookupCompanyByVat('0999999999', { redis: r as never });
    const again = await lookupCompanyByVat('0999999999', { redis: r as never });
    expect(again).toMatchObject({ status: 'not_found', cached: true });
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache an outage — the next attempt must be allowed to succeed', async () => {
    const r = redis();
    axiosGet.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ data: COLRUYT });

    const first = await lookupCompanyByVat('0400378485', { redis: r as never });
    const second = await lookupCompanyByVat('0400378485', { redis: r as never });

    expect(first.status).toBe('unavailable');
    expect(second.status).toBe('found'); // recovered rather than serving a stale failure
  });

  it('keeps working when Redis itself is down', async () => {
    // House pattern: no cache means every lookup is slow, not that lookups stop.
    const broken = {
      get: vi.fn(async () => { throw new Error('redis down'); }),
      set: vi.fn(async () => { throw new Error('redis down'); }),
    };
    axiosGet.mockResolvedValue({ data: COLRUYT });
    const r = await lookupCompanyByVat('0400378485', { redis: broken as never });
    expect(r.status).toBe('found');
  });
});
