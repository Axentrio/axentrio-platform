import { originFromSourceUrl } from "./website-url";

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
 * Builds the crawl's robots.txt predicate for one origin. A missing,
 * redirected, or unreachable robots.txt allows every path.
 */
export async function fetchRobotsAllows(
  originUrl: string,
  get: (url: string) => Promise<{ status: number; body: string }>,
): Promise<(pageUrl: string) => Promise<boolean>> {
  const allowAll = async () => true;
  const origin = originFromSourceUrl(originUrl);
  if (!origin) return allowAll;

  let response: { status: number; body: string };
  try {
    response = await get(`${origin}/robots.txt`);
  } catch {
    return allowAll;
  }
  if (response.status !== 200) return allowAll;

  const robots = parseRobotsTxt(response.body);
  return async (pageUrl: string) => robots.allows(pathFromPageUrl(pageUrl));
}
