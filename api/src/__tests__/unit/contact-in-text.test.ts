import { describe, it, expect } from 'vitest';
import { containsContactData } from '../../insights/contact-in-text';

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

  it('passes an aggregate figure and an ISO date', () => {
    expect(
      containsContactData('Between 2026-09-01 and 2026-09-07 you handled 1 000 000 000 chats.'),
    ).toBe(false);
  });

  it('treats empty text as clean', () => {
    expect(containsContactData('')).toBe(false);
  });
});
