/**
 * Per-bot widget origin allow-list.
 *
 * Patterns are hostnames (no scheme, no path), optional leading `*.`, optional
 * `:port`. Empty list = allow every website. `*.example.com` covers the apex
 * and every subdomain.
 */
export const ORIGIN_PATTERN_RE = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/;

export function originMatches(patterns: string[], origin: string | undefined): boolean {
  if (patterns.length === 0) return true;
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const port =
    url.port ||
    (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) continue;
    const portMatch = pattern.match(/:(\d{1,5})$/);
    const patternHost = portMatch ? pattern.slice(0, -portMatch[0].length) : pattern;
    const patternPort = portMatch ? portMatch[1] : null;
    if (patternPort !== null && patternPort !== port) continue;
    if (patternHost.startsWith('*.')) {
      const suffix = patternHost.slice(2);
      if (host === suffix || host.endsWith(`.${suffix}`)) return true;
    } else if (host === patternHost) {
      return true;
    }
  }
  return false;
}
