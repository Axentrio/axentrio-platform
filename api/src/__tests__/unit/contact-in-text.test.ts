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

  it('treats empty text as clean', () => {
    expect(containsContactData('')).toBe(false);
  });
});
