import { describe, it, expect, vi } from 'vitest';
import {
  isPublicAddress,
  assertSafeOutboundUrl,
  safeOutboundRequest,
  ssrfLookup,
  SsrfError,
} from '../../security/ssrf-guard';

describe('isPublicAddress (#A)', () => {
  it('allows public unicast IPv4/IPv6', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('blocks private/loopback/link-local/metadata/multicast/unspecified', () => {
    for (const ip of [
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
      '0.0.0.0', '224.0.0.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

describe('assertSafeOutboundUrl (#A)', () => {
  it('accepts a public https URL', () => {
    expect(() => assertSafeOutboundUrl('https://hooks.example.com/x')).not.toThrow();
    expect(() => assertSafeOutboundUrl('https://example.com.')).not.toThrow(); // trailing dot
  });
  it('rejects non-https', () => {
    expect(() => assertSafeOutboundUrl('http://example.com')).toThrow(SsrfError);
    expect(() => assertSafeOutboundUrl('ftp://example.com')).toThrow(SsrfError);
  });
  it('rejects private IP literals (incl. IPv6 + IPv4-mapped + zone id)', () => {
    for (const u of [
      'https://127.0.0.1', 'https://10.0.0.1', 'https://169.254.169.254',
      'https://[::1]', 'https://[::ffff:10.0.0.1]', 'https://[fe80::1%25eth0]',
    ]) {
      expect(() => assertSafeOutboundUrl(u), u).toThrow(SsrfError);
    }
  });
  it('rejects garbage', () => {
    expect(() => assertSafeOutboundUrl('not a url')).toThrow(SsrfError);
  });
});

describe('safeOutboundRequest (#A)', () => {
  it('rejects an unsafe URL before any network I/O', async () => {
    await expect(safeOutboundRequest({ url: 'http://169.254.169.254/latest' })).rejects.toThrow(SsrfError);
    await expect(safeOutboundRequest({ url: 'https://127.0.0.1' })).rejects.toThrow(SsrfError);
  });
});

describe('ssrfLookup (#A DNS-rebind / mixed answers)', () => {
  it('rejects when ANY resolved address is non-public', async () => {
    vi.resetModules();
    const dns = await import('dns');
    const spy = vi.spyOn(dns.default, 'lookup').mockImplementation((((_h: any, _o: any, cb: any) => {
      cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    }) as any));
    const err = await new Promise<Error | null>((resolve) =>
      ssrfLookup('evil.example.com', {} as any, (e) => resolve(e)),
    );
    expect(err).toBeInstanceOf(Error);
    spy.mockRestore();
  });
  it('passes through when all answers are public', async () => {
    const dns = await import('dns');
    const spy = vi.spyOn(dns.default, 'lookup').mockImplementation((((_h: any, _o: any, cb: any) => {
      cb(null, [{ address: '8.8.8.8', family: 4 }]);
    }) as any));
    const res = await new Promise<{ err: Error | null; addr: unknown }>((resolve) =>
      ssrfLookup('good.example.com', {} as any, (e, addr) => resolve({ err: e, addr })),
    );
    expect(res.err).toBeNull();
    expect(res.addr).toBe('8.8.8.8');
    spy.mockRestore();
  });
});
