import { isSameHost, originFromSourceUrl } from "./website-url";

export const KNOWLEDGE_BOT_UA = "Axentrio-KnowledgeBot";

export function parseRobotsTxt(body: string): {
  allows: (path: string) => boolean;
} {
  const disallows: string[] = [];
  let ua = "";
  let applies = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      ua = value.toLowerCase();
      applies = ua === "*" || ua === KNOWLEDGE_BOT_UA.toLowerCase();
      continue;
    }
    if (field === "disallow" && applies && value) {
      disallows.push(value);
    }
  }

  return {
    allows(path: string): boolean {
      // Google robots semantics: a Disallow prefix matches any path that
      // starts with it, so "/private" also blocks "/privateX".
      return !disallows.some((prefix) => path.startsWith(prefix));
    },
  };
}

/** Path + query of a page URL, as robots.txt matching expects it. */
export function pathFromPageUrl(pageUrl: string): string {
  try {
    const parsed = new URL(pageUrl);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}

/**
 * The forms a robots rule can name this page by. `canonicalSourceUrl` removes
 * a trailing slash, so the page queued as "/my-account" is the directory URL
 * that a "Disallow: /my-account/" rule names. Both forms are matched.
 */
function robotsPathsFor(pageUrl: string): string[] {
  const path = pathFromPageUrl(pageUrl);
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return [path];
  }
  if (parsed.pathname.endsWith("/")) return [path];
  return [path, `${parsed.pathname}/${parsed.search}`];
}

const REDIRECT_STATUS = [301, 302, 303, 307, 308];

/**
 * Builds the crawl's robots.txt predicate for one origin. A missing or
 * unreachable robots.txt allows every path. One same-host redirect hop is
 * followed, because the apex host of a site usually redirects to `www`, and
 * `isSameHost` lets the crawl reach both. Anything else allows every path.
 */
export async function fetchRobotsAllows(
  originUrl: string,
  get: (
    url: string,
  ) => Promise<{ status: number; body: string; location?: string }>,
): Promise<(pageUrl: string) => Promise<boolean>> {
  const allowAll = async () => true;
  const origin = originFromSourceUrl(originUrl);
  if (!origin) return allowAll;

  let robotsUrl = `${origin}/robots.txt`;
  let body: string | null = null;

  for (let hop = 0; hop < 2 && body === null; hop += 1) {
    let response: { status: number; body: string; location?: string };
    try {
      response = await get(robotsUrl);
    } catch {
      return allowAll;
    }
    if (response.status === 200) {
      body = response.body;
      break;
    }
    if (!REDIRECT_STATUS.includes(response.status) || !response.location) {
      return allowAll;
    }
    let next: string;
    try {
      next = new URL(response.location, robotsUrl).toString();
    } catch {
      return allowAll;
    }
    if (!isSameHost(robotsUrl, next)) return allowAll;
    robotsUrl = next;
  }

  if (body === null) return allowAll;
  const robots = parseRobotsTxt(body);
  return async (pageUrl: string) =>
    robotsPathsFor(pageUrl).every((path) => robots.allows(path));
}
