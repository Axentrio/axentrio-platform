import { describe, expect, it } from 'vitest';
import { normalizeWebsiteUrl } from './websiteUrl';

describe('normalizeWebsiteUrl', () => {
  it('adds https to a bare domain and a www host', () => {
    expect(normalizeWebsiteUrl('valyro.be')).toBe('https://valyro.be');
    expect(normalizeWebsiteUrl('www.valyro.be')).toBe('https://www.valyro.be');
  });
  it('adds https to a bare host with a port', () => {
    expect(normalizeWebsiteUrl('valyro.be:8080')).toBe(
      'https://valyro.be:8080',
    );
  });

  it('keeps a full https URL', () => {
    expect(normalizeWebsiteUrl('https://www.valyro.be')).toBe(
      'https://www.valyro.be',
    );
  });

  it('upgrades http to https', () => {
    expect(normalizeWebsiteUrl('http://valyro.be')).toBe('https://valyro.be');
  });

  it('trims spaces and keeps a path', () => {
    expect(normalizeWebsiteUrl('  valyro.be/diensten  ')).toBe(
      'https://valyro.be/diensten',
    );
  });

  it('returns empty for blank input', () => {
    expect(normalizeWebsiteUrl('   ')).toBe('');
  });
});
