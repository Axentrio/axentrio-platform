import { describe, it, expect } from 'vitest';
import { originMatches } from '../../security/widget-origin';

describe('originMatches', () => {
  it('lets every origin through when the list is empty', () => {
    expect(originMatches([], undefined)).toBe(true);
    expect(originMatches([], 'https://evil.example')).toBe(true);
  });

  it('denies a missing Origin when a list is set', () => {
    expect(originMatches(['example.com'], undefined)).toBe(false);
  });

  it('matches a wildcard against the apex and subdomains, not sibling hosts', () => {
    expect(originMatches(['*.example.com'], 'https://example.com')).toBe(true);
    expect(originMatches(['*.example.com'], 'https://shop.example.com')).toBe(true);
    expect(originMatches(['*.example.com'], 'https://example.com.evil.io')).toBe(false);
  });

  it('matches an exact hostname only', () => {
    expect(originMatches(['example.com'], 'https://www.example.com')).toBe(false);
    expect(originMatches(['example.com'], 'https://example.com')).toBe(true);
  });

  it('matches ports only when the pattern names one', () => {
    expect(originMatches(['localhost:5173'], 'http://localhost:5173')).toBe(true);
    expect(originMatches(['localhost:5173'], 'http://localhost:3000')).toBe(false);
    expect(originMatches(['localhost'], 'http://localhost:3000')).toBe(true);
  });

  it('rejects an unparseable origin', () => {
    expect(originMatches(['example.com'], 'not a url')).toBe(false);
  });
});
