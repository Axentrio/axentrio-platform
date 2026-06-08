/**
 * SSRF guard for outbound requests to tenant-controlled URLs (webhooks).
 *
 * Tenants can configure arbitrary webhook URLs; without a guard the server would
 * happily POST to localhost, RFC1918, or the cloud metadata endpoint
 * (169.254.169.254). This module enforces: https-only, no IP-literal private
 * hosts, and — authoritatively at connect time via a custom DNS `lookup` —
 * rejection of any hostname that resolves to a non-public address (DNS-rebind
 * safe, because the rejection happens at the actual socket resolution). See
 * security audit #A.
 */
import https from 'https';
import dns from 'dns';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import ipaddr from 'ipaddr.js';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** True only for globally-routable unicast addresses (IPv4 + IPv6). */
export function isPublicAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return false;
  }
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address();
  }
  // ipaddr.js classifies routable public addresses as 'unicast'; everything
  // else (private, loopback, linkLocal, uniqueLocal, reserved, multicast,
  // carrierGradeNat, unspecified, broadcast, teredo, 6to4, …) is non-public.
  return addr.range() === 'unicast';
}

/**
 * Validate a raw outbound URL synchronously: require https, and if the host is
 * an IP literal (Node's custom `lookup` is skipped for literals) classify it
 * directly. Returns the parsed URL or throws SsrfError.
 */
export function assertSafeOutboundUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('Invalid webhook URL');
  }
  if (url.protocol !== 'https:') {
    throw new SsrfError('Webhook URL must use https');
  }
  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 literal
  if (host.includes('%')) throw new SsrfError('Webhook URL host may not contain a zone id'); // fe80::1%eth0
  if (host.endsWith('.')) host = host.slice(0, -1); // trailing dot
  if (ipaddr.isValid(host) && !isPublicAddress(host)) {
    throw new SsrfError('Webhook URL resolves to a non-public address');
  }
  return url;
}

/**
 * Custom DNS lookup that resolves ALL answers and rejects if ANY is non-public
 * (defeats mixed public/private DNS answers); fails closed on resolution error.
 * Used as the https.Agent lookup so the check happens at connect time.
 */
export function ssrfLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions | number,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '');
    for (const a of addresses) {
      if (!isPublicAddress(a.address)) {
        return callback(new SsrfError(`Blocked SSRF target: ${hostname} → ${a.address}`) as NodeJS.ErrnoException, '');
      }
    }
    if (typeof options === 'object' && options.all) {
      return callback(null, addresses);
    }
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/** Shared https.Agent that rejects connections to non-public resolved IPs. */
export const ssrfHttpsAgent = new https.Agent({ lookup: ssrfLookup });

/**
 * Make a guarded outbound request. Forces the SSRF agent, no redirects, and no
 * proxy (so the agent's lookup stays authoritative). Does NOT impose a
 * validateStatus — callers keep their own non-2xx semantics (the n8n dispatcher
 * relies on 4xx=no-retry / 5xx=retry). Throws SsrfError before any network I/O
 * when the URL is unsafe.
 */
export async function safeOutboundRequest(config: AxiosRequestConfig): Promise<AxiosResponse> {
  assertSafeOutboundUrl(String(config.url));
  return axios.request({
    ...config,
    httpsAgent: ssrfHttpsAgent,
    maxRedirects: 0,
    proxy: false,
  });
}
