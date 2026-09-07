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

  it('treats default http/https ports as omitted on the Origin', () => {
    expect(originMatches(['example.com:443'], 'https://example.com')).toBe(true);
    expect(originMatches(['example.com:443'], 'https://example.com:443')).toBe(true);
    expect(originMatches(['example.com:80'], 'http://example.com')).toBe(true);
    expect(originMatches(['localhost:80'], 'http://localhost')).toBe(true);
    expect(originMatches(['example.com:443'], 'http://example.com')).toBe(false);
  });

  it('rejects an unparseable origin', () => {
    expect(originMatches(['example.com'], 'not a url')).toBe(false);
  });

  it('rejects the opaque Origin null string when a list is set', () => {
    // Sandboxed iframes and file:// pages send the literal header Origin: null.
    expect(originMatches(['example.com'], 'null')).toBe(false);
    expect(originMatches([], 'null')).toBe(true);
  });
});
