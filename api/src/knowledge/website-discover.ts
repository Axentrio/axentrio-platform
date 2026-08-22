import dns from "dns/promises";
import { isPublicAddress, safeOutboundRequest } from "../security/ssrf-guard";
import { canonicalSourceUrl } from "./website-url";

export const DISCOVERY_PREFIXES = [
  "www",
  "app",
  "api",
  "admin",
  "mail",
  "blog",
  "shop",
  "store",
  "portal",
  "dashboard",
  "login",
  "auth",
  "cdn",
  "docs",
  "staging",
  "stage",
  "test",
  "beta",
  "demo",
  "m",
  "crm",
  "go",
  "book",
  "booking",
  "clients",
  "client",
  "my",
  "hub",
  "chat",
  "bot",
  "widget",
  "studio",
  "copilot",
  "ops",
  "status",
  "help",
  "support",
  "kb",
] as const;

const MAX_EXTRA_HOSTS = 20;

function assertPublicIps(ips: string[]): void {
  if (ips.length === 0) throw new Error("no address");
  for (const ip of ips) {
    if (!isPublicAddress(ip)) throw new Error("non-public");
  }
}

export function apexHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

export function isSubdomainOfApex(host: string, apex: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const a = apex.toLowerCase();
  return h === a || h.endsWith(`.${a}`);
}

/** Origin plus its www twin: the same public site, not an extra host. */
export function sameSiteHosts(originHost: string): Set<string> {
  const h = originHost.toLowerCase().replace(/\.$/, "");
  const apex = apexHost(h);
  return new Set([h, apex, `www.${apex}`]);
}

export function parseCrtNameValues(records: unknown): string[] {
  if (!Array.isArray(records)) return [];
  const names = new Set<string>();
  for (const rec of records.slice(0, 300)) {
    if (typeof rec === "string") {
      addCtName(names, rec);
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    const row = rec as { name_value?: unknown; sub?: unknown; name?: unknown };
    if (typeof row.sub === "string") addCtName(names, row.sub);
    if (typeof row.name === "string") addCtName(names, row.name);
    if (typeof row.name_value === "string") {
      for (const part of row.name_value.split(/\n/)) addCtName(names, part);
    }
  }
  return [...names];
}

function addCtName(names: Set<string>, raw: string): void {
  let n = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!n) return;
  if (n.startsWith("*.")) n = n.slice(2);
  if (n) names.add(n);
}

/** crt.name returns JSON `{sub}` rows or one host per line. crt.sh returns SAN records. */
export function parseCtPayload(payload: unknown): string[] {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return parseCrtNameValues(JSON.parse(trimmed) as unknown);
      } catch {
        // not JSON; treat as one host per line
      }
    }
    return parseCrtNameValues(trimmed.split(/\r?\n/));
  }
  return parseCrtNameValues(payload);
}

export type DiscoveredHost = {
  host: string;
  url: string;
  sources: Array<"dns" | "ct">;
};

export type DiscoverDeps = {
  lookup: (host: string) => Promise<string[]>;
  fetchCt?: (apex: string) => Promise<unknown>;
};

export async function defaultLookup(host: string): Promise<string[]> {
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  const ips = answers.map((a) => a.address);
  if (ips.length === 0) throw new Error("no address");
  for (const ip of ips) {
    if (!isPublicAddress(ip)) throw new Error("non-public");
  }
  return ips;
}

export async function defaultFetchCt(apex: string): Promise<unknown> {
  try {
    const primary = await safeOutboundRequest({
      url: `https://crt.name/v1/search?apex=${encodeURIComponent(apex)}`,
      method: "GET",
      timeout: 8000,
      responseType: "text",
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (primary.status < 400 && typeof primary.data === "string" && primary.data.trim()) {
      return primary.data;
    }
  } catch {
    // fall through to crt.sh
  }
  const fallback = await safeOutboundRequest({
    url: `https://crt.sh/?q=${encodeURIComponent(`%.${apex}`)}&output=json`,
    method: "GET",
    timeout: 8000,
    validateStatus: (s) => s >= 200 && s < 500,
  });
  if (fallback.status >= 400) return [];
  return fallback.data;
}

export async function discoverExtraHosts(
  rawUrl: string,
  deps: DiscoverDeps = { lookup: defaultLookup, fetchCt: defaultFetchCt },
): Promise<{ origin: string; apex: string; hosts: DiscoveredHost[] }> {
  const origin = canonicalSourceUrl(rawUrl);
  let originHost: string;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    throw new Error("Invalid website URL");
  }
  const apex = apexHost(originHost);
  const skip = sameSiteHosts(originHost);
  const sources = new Map<string, Set<"dns" | "ct">>();

  const mark = (host: string, source: "dns" | "ct") => {
    const h = host.toLowerCase().replace(/\.$/, "");
    if (!isSubdomainOfApex(h, apex)) return;
    if (skip.has(h)) return;
    if (!h.includes(".")) return;
    const set = sources.get(h) ?? new Set<"dns" | "ct">();
    set.add(source);
    sources.set(h, set);
  };

  await Promise.all(
    DISCOVERY_PREFIXES.map(async (prefix) => {
      const host = `${prefix}.${apex}`;
      if (skip.has(host)) return undefined;
      try {
        assertPublicIps(await deps.lookup(host));
        mark(host, "dns");
      } catch {
        // name does not exist or is not public
      }
      return undefined;
    }),
  );

  if (deps.fetchCt) {
    try {
      const records = await deps.fetchCt(apex);
      for (const name of parseCtPayload(records)) {
        mark(name, "ct");
      }
    } catch {
      // CT is optional; DNS hits still return
    }
  }

  const live: DiscoveredHost[] = [];
  for (const [host, src] of sources) {
    try {
      assertPublicIps(await deps.lookup(host));
      live.push({
        host,
        url: `https://${host}/`,
        sources: [...src],
      });
    } catch {
      // CT name with no public DNS
    }
    if (live.length >= MAX_EXTRA_HOSTS) break;
  }

  live.sort((a, b) => a.host.localeCompare(b.host));
  return { origin, apex, hosts: live };
}
