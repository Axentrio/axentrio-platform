import { logger } from "../utils/logger";

export const KNOWLEDGE_BOT_UA = "Axentrio-KnowledgeBot";

interface RobotsRule {
  allow: boolean;
  pattern: string;
  matcher: RegExp;
}

// Google robots semantics: a rule is a path prefix, so "/private" also
// blocks "/privateX".
function ruleMatcher(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const source = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}

export function parseRobotsTxt(body: string): {
  allows: (path: string) => boolean;
} {
  const ownAgent = KNOWLEDGE_BOT_UA.toLowerCase();
  const ownRules: RobotsRule[] = [];
  const starRules: RobotsRule[] = [];
  let namesOwnAgent = false;
  let agents: string[] = [];
  let groupHasRules = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (groupHasRules) {
        agents = [];
        groupHasRules = false;
      }
      const agent = value.toLowerCase();
      agents.push(agent);
      if (agent === ownAgent) namesOwnAgent = true;
      continue;
    }
    if (field !== "allow" && field !== "disallow") continue;
    groupHasRules = true;
    if (!value) continue;
    const rule = {
      allow: field === "allow",
      pattern: value,
      matcher: ruleMatcher(value),
    };
    if (agents.includes(ownAgent)) ownRules.push(rule);
    if (agents.includes("*")) starRules.push(rule);
  }

  const rules = namesOwnAgent ? ownRules : starRules;
  return {
    allows(path: string): boolean {
      let winner: RobotsRule | undefined;
      for (const rule of rules) {
        if (!rule.matcher.test(path)) continue;
        if (
          !winner ||
          rule.pattern.length > winner.pattern.length ||
          (rule.pattern.length === winner.pattern.length && rule.allow)
        ) {
          winner = rule;
        }
      }
      return winner?.allow ?? true;
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
  if (res.status >= 400 && res.status < 500) {
    return async () => true;
  }
  if (res.status < 200 || res.status >= 300) {
    return refuseCrawl(originUrl, `robots.txt returned status ${res.status}`);
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
