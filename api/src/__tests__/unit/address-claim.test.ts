import { describe, expect, it } from 'vitest';
import { addressClaimIn } from '../../agent/agent.service';

describe('addressClaimIn', () => {
  it('recognises the authoritative Belgian address in natural-language prose', () => {
    expect(
      addressClaimIn(
        'Your booking is confirmed at Kerkstraat 12, 2000 Antwerpen.',
        'Kerkstraat 12, 2000 Antwerpen, België'
      )
    ).toBe(true);
  });

  it('normalises case, accents, punctuation, and whitespace', () => {
    expect(
      addressClaimIn(
        'Afspraak:  KERKSTRAAT 12 — 2000 Antwerpen, Belgie!',
        'Kerkstraat 12, 2000 Antwerpen, België'
      )
    ).toBe(true);
  });

  it('rejects a different door number', () => {
    expect(
      addressClaimIn(
        'Your booking is confirmed at Kerkstraat 1, 2000 Antwerpen.',
        'Kerkstraat 12, 2000 Antwerpen, België'
      )
    ).toBe(false);
  });

  it('rejects a street-only claim when the authoritative address has a door number', () => {
    expect(
      addressClaimIn(
        'Your booking is confirmed on Kerkstraat in Antwerpen.',
        'Kerkstraat 12, 2000 Antwerpen, België'
      )
    ).toBe(false);
  });

  it('does not mistake an unseparated four-digit door number for a postcode', () => {
    expect(addressClaimIn('The visit is at Langeweg 2000 Gent.', 'Langeweg 2000 Gent')).toBe(true);
    expect(addressClaimIn('The visit is at Langeweg in Gent.', 'Langeweg 2000 Gent')).toBe(false);
  });

  it('may omit an unseparated postcode when a distinct door number precedes it', () => {
    expect(
      addressClaimIn(
        'The visit is at Kerkstraat 12 Antwerpen.',
        'Kerkstraat 12 2000 Antwerpen België'
      )
    ).toBe(true);
  });
});
