/**
 * resolveBusinessTimezone — the pure geography→IANA resolver (PR 1a, A1).
 *
 * Belgium-only: the only valid answer is Europe/Brussels, derived from the
 * business's admitted geography (venue country first, else the tenant's
 * operating country) and NEVER from a browser clock. Unsupported countries
 * are rejected at the business-location boundary rather than guessed at.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveBusinessTimezone,
  UnsupportedBusinessCountryError,
  DEFAULT_BUSINESS_TIMEZONE,
  DEFAULT_OPERATING_COUNTRY,
} from '../../booking/business-timezone';

describe('resolveBusinessTimezone', () => {
  it('BE → Europe/Brussels (operating country, no venue)', () => {
    expect(resolveBusinessTimezone({ country: 'BE' })).toBe('Europe/Brussels');
  });

  it('normalises case and whitespace', () => {
    expect(resolveBusinessTimezone({ country: ' be ' })).toBe('Europe/Brussels');
    expect(resolveBusinessTimezone({ country: 'BE', venue: { country: 'be' } })).toBe('Europe/Brussels');
  });

  it('the VENUE country wins over the operating country when both are stated', () => {
    // A supported venue in an (hypothetically) different tenant country still
    // derives from the venue — the venue is where the business actually is.
    expect(resolveBusinessTimezone({ country: 'XX', venue: { country: 'BE' } })).toBe('Europe/Brussels');
  });

  it('a venue WITHOUT a country falls back to the operating country', () => {
    expect(resolveBusinessTimezone({ country: 'BE', venue: { country: null } })).toBe('Europe/Brussels');
    expect(resolveBusinessTimezone({ country: 'BE', venue: {} })).toBe('Europe/Brussels');
  });

  it('nothing at all falls back to the platform default (BE)', () => {
    expect(DEFAULT_OPERATING_COUNTRY).toBe('BE');
    expect(resolveBusinessTimezone({})).toBe(DEFAULT_BUSINESS_TIMEZONE);
    expect(resolveBusinessTimezone({ country: null, venue: null })).toBe(DEFAULT_BUSINESS_TIMEZONE);
  });

  it('REJECTS an unsupported venue country — no guessing', () => {
    expect(() => resolveBusinessTimezone({ country: 'BE', venue: { country: 'NL' } })).toThrow(
      UnsupportedBusinessCountryError,
    );
    try {
      resolveBusinessTimezone({ country: 'BE', venue: { country: 'NL' } });
    } catch (err) {
      expect((err as UnsupportedBusinessCountryError).country).toBe('NL');
      expect((err as Error).message).toContain('NL');
    }
  });

  it('REJECTS an unsupported operating country when no venue narrows it', () => {
    expect(() => resolveBusinessTimezone({ country: 'FR' })).toThrow(UnsupportedBusinessCountryError);
  });
});
