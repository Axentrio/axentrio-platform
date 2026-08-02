/**
 * The identity rule for repeat detection.
 *
 * This is the one function in the feature where being wrong is unrecoverable: a wrong
 * merge shows one customer another customer's history, while a missed repeat costs a
 * badge nobody sees. So most of what follows asserts what the rule REFUSES to merge,
 * not what it merges.
 */
import { describe, it, expect } from 'vitest';
import {
  computePersonKey,
  normalizePersonEmail,
  normalizePersonPhone,
} from '../../leads/person-key';

describe('normalizePersonPhone — E.164 or nothing', () => {
  it('collapses every spelling of the same international number', () => {
    // These are the four forms this platform actually stores: a WhatsApp wa_id, what
    // the capture path leaves after stripping punctuation, and both international
    // prefixes as a customer might type them into the widget.
    const forms = ['32475464421', '+32 475 46 44 21', '0032475464421', '+32-475-464-421'];
    for (const form of forms) {
      expect(normalizePersonPhone(form)).toBe('+32475464421');
    }
  });

  it('refuses a trunk-prefixed national number rather than guessing the country', () => {
    // `0475464421` is Belgian OR French OR Dutch depending on who typed it. Inferring
    // from the tenant's locale would merge two different people who share the digits.
    expect(normalizePersonPhone('0475464421')).toBeNull();
    expect(normalizePersonPhone('0475 46 44 21')).toBeNull();
  });

  it('refuses a national number with NO trunk prefix, which shape alone cannot catch', () => {
    // The dangerous case, and the one a shape-only rule got wrong: the column stores
    // digits, so `4155550100` looks exactly like an international number. Prefixed with
    // `+` it reads as Switzerland (+41), `2125551234` as Morocco (+212), `3331234567`
    // as France (+33). Each would key a US customer as a European one and merge them
    // with whoever genuinely holds that number. Validation rejects all of them because
    // they are not valid numbers in the country their prefix claims.
    expect(normalizePersonPhone('4155550100')).toBeNull(); // NANP → would be +41 CH
    expect(normalizePersonPhone('(415) 555-0100')).toBeNull();
    expect(normalizePersonPhone('2125551234')).toBeNull(); // NYC → would be +212 MA
    expect(normalizePersonPhone('3331234567')).toBeNull(); // IT → would be +33 FR
    expect(normalizePersonPhone('612345678')).toBeNull(); // ES → would be +61 AU
  });

  it('refuses filler numbers operators type into a required field', () => {
    // Five imported contacts sharing `1111111111` became one person with five
    // conversations before this.
    expect(normalizePersonPhone('1111111111')).toBeNull();
    expect(normalizePersonPhone('0000000000')).toBeNull();
    expect(normalizePersonPhone('1234567890')).toBeNull();
  });

  it('still accepts the real numbers this platform actually serves', () => {
    // The rejections above must not have been bought by refusing everything.
    expect(normalizePersonPhone('32475464421')).toBe('+32475464421'); // BE
    expect(normalizePersonPhone('31612345678')).toBe('+31612345678'); // NL
    expect(normalizePersonPhone('33612345678')).toBe('+33612345678'); // FR
  });

  it('refuses placeholder email addresses rather than merging everyone who shares one', () => {
    // A valid address by shape, and the value many unrelated rows carry.
    expect(normalizePersonEmail('unknown@example.com')).toBeNull();
    expect(normalizePersonEmail('none@none.com')).toBeNull();
    expect(normalizePersonEmail('noreply@acme.be')).toBeNull();
    // A real address whose local part merely resembles one must survive.
    expect(normalizePersonEmail('unknown.soldier@acme.be')).toBe('unknown.soldier@acme.be');
  });

  it('refuses a value that is not shaped like an address at all', () => {
    expect(normalizePersonEmail('not-an-email')).toBeNull();
    expect(normalizePersonEmail('a@b')).toBeNull(); // no TLD
    expect(normalizePersonEmail('@example.com')).toBeNull();
  });

  it('refuses values that cannot be a phone number at all', () => {
    expect(normalizePersonPhone(null)).toBeNull();
    expect(normalizePersonPhone(undefined)).toBeNull();
    expect(normalizePersonPhone('')).toBeNull();
    expect(normalizePersonPhone('n/a')).toBeNull();
    expect(normalizePersonPhone('12345')).toBeNull(); // too short to be international
    expect(normalizePersonPhone('1234567890123456')).toBeNull(); // longer than E.164 allows
  });
});

describe('normalizePersonEmail — exact, with no provider folding', () => {
  it('trims and lowercases', () => {
    expect(normalizePersonEmail('  Achraf@Example.COM ')).toBe('achraf@example.com');
  });

  it('keeps plus-addressed mailboxes distinct', () => {
    // Stripping `+tag` is a well-known gmail trick and would merge two different
    // people behind one shared company address.
    expect(normalizePersonEmail('shared+alice@company.com')).not.toBe(
      normalizePersonEmail('shared+bob@company.com'),
    );
  });

  it('refuses a value that is not an address', () => {
    expect(normalizePersonEmail('unknown')).toBeNull();
    expect(normalizePersonEmail('   ')).toBeNull();
    expect(normalizePersonEmail(null)).toBeNull();
  });
});

describe('computePersonKey — phone wins, and names never count', () => {
  it('prefers phone when both identifiers are present', () => {
    // Load-bearing: every external channel identifies a customer by phone and never
    // by email, so keying a phone+email row on its email would leave it unable to
    // group with the WhatsApp row belonging to the same person.
    expect(computePersonKey({ phone: '32475464421', email: 'a@b.com' })).toBe('phone:+32475464421');
  });

  it('falls back to email when the phone is unusable', () => {
    expect(computePersonKey({ phone: '0475464421', email: 'A@B.com' })).toBe('email:a@b.com');
    expect(computePersonKey({ phone: null, email: 'a@b.com' })).toBe('email:a@b.com');
  });

  it('returns null when neither identifier resolves', () => {
    expect(computePersonKey({})).toBeNull();
    expect(computePersonKey({ phone: 'call me', email: 'none' })).toBeNull();
  });

  it('never merges two people who only share a name', () => {
    // There is no name input at all, by design — this asserts the shape of the
    // contract, so an "improvement" that adds fuzzy name matching has to delete a test
    // that says why it must not.
    const a = computePersonKey({ email: 'jan.peeters@a.com' });
    const b = computePersonKey({ email: 'jan.peeters@b.com' });
    expect(a).not.toBe(b);
  });

  it('keeps the phone and email namespaces apart', () => {
    expect(computePersonKey({ phone: '32475464421' })).not.toBe(
      computePersonKey({ email: '+32475464421@x.com' }),
    );
  });

  it('is deterministic — the same inputs always produce the same key', () => {
    // The sweep recomputes from scratch every run, so a key that drifted between runs
    // would silently re-partition people every night.
    const once = computePersonKey({ phone: '+32 475 46 44 21' });
    const twice = computePersonKey({ phone: '0032475464421' });
    expect(once).toBe(twice);
  });
});
