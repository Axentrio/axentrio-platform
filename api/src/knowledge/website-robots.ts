import { logger } from "../utils/logger";

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

export async function fetchRobotsAllows(
  originUrl: string,
  get: (url: string) => Promise<{ status: number; body: string }>,
): Promise<(pageUrl: string) => Promise<boolean>> {
  let res: { status: number; body: string };
  try {
    res = await get(new URL("/robots.txt", originUrl).toString());
  } catch (error) {
    return refuseCrawl(
      originUrl,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (res.status >= 500) {
    return refuseCrawl(originUrl, `robots.txt returned status ${res.status}`);
  }
  if (res.status !== 200) {
    return async () => true;
  }
  const { allows } = parseRobotsTxt(res.body);
  return async (pageUrl: string) => {
    const { pathname, search } = new URL(pageUrl);
    const directory = pathname.endsWith("/") ? pathname : `${pathname}/`;
    return allows(`${pathname}${search}`) && allows(`${directory}${search}`);
  };
}

function refuseCrawl(
  originUrl: string,
  cause: string,
): (pageUrl: string) => Promise<boolean> {
  logger.warn("Website crawl refused: robots.txt unreachable", {
    origin: originUrl,
    cause,
  });
  return async () => false;
}
