import { describe, it, expect } from 'vitest';
import { containsContactData, countContactMatches } from '../../insights/contact-in-text';

describe('containsContactData', () => {
  it('passes aggregate insight text', () => {
    expect(containsContactData('Publish your prices.')).toBe(false);
  });

  it('finds an email address embedded in a sentence', () => {
    expect(containsContactData('Email jane@x.com for prices.')).toBe(true);
  });

  it('finds a phone number embedded in a sentence', () => {
    expect(containsContactData('Call +32470123456 today.')).toBe(true);
  });

  it('finds a domestic phone number written with the trunk zero', () => {
    expect(containsContactData('Call the customer on 0470 12 34 56 about pricing.')).toBe(true);
  });

  it('finds a domestic landline number', () => {
    expect(containsContactData('Ring 02 123 45 67 before noon.')).toBe(true);
  });

  it('finds a domestic mobile number written with the Belgian slash', () => {
    expect(containsContactData('Call the customer back on 0470/12.34.56 about the quote.')).toBe(true);
  });

  it('finds a domestic landline number written with the Belgian slash', () => {
    expect(containsContactData('Ring 02/123.45.67 before noon.')).toBe(true);
  });

  it('passes a sentence naming two dd/mm/yyyy dates', () => {
    expect(containsContactData('Bookings ran 09/09/2026 through 10/09/2026.')).toBe(false);
  });

  it('passes an aggregate figure and an ISO date', () => {
    expect(
      containsContactData('Between 2026-09-01 and 2026-09-07 you handled 1 000 000 000 chats.'),
    ).toBe(false);
  });

  it('treats empty text as clean', () => {
    expect(containsContactData('')).toBe(false);
  });
});

describe('countContactMatches', () => {
  it('counts the values without ever returning them', () => {
    const counts = countContactMatches(
      'Mail jan@acme.com or sara@acme.com, or call 0470 12 34 56 and +32 470 11 22 33.',
    );
    expect(counts).toEqual({ emails: 2, phones: 2 });
  });

  it('counts nothing in clean text', () => {
    expect(countContactMatches('Our opening hours are 9 to 6, closed on 2026-12-25.')).toEqual({
      emails: 0,
      phones: 0,
    });
    expect(countContactMatches('')).toEqual({ emails: 0, phones: 0 });
  });

  it('does not carry regex state between calls', () => {
    const text = 'one@acme.com and two@acme.com';
    expect(countContactMatches(text).emails).toBe(2);
    expect(countContactMatches(text).emails).toBe(2);
  });
});
