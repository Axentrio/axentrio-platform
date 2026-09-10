import { logger } from "../utils/logger";

export const KNOWLEDGE_BOT_UA = "Axentrio-KnowledgeBot";

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

// Google robots semantics: a rule is a path prefix, so "/private" also
// blocks "/privateX".
function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const segments = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = segments[0];
  if (!path.startsWith(first)) return false;
  if (segments.length === 1) return !anchored || path.length === first.length;
  let position = first.length;
  for (const segment of segments.slice(1, -1)) {
    const found = path.indexOf(segment, position);
    if (found < 0) return false;
    position = found + segment.length;
  }
  const last = segments[segments.length - 1];
  if (anchored) {
    return path.length - last.length >= position && path.endsWith(last);
  }
  return path.indexOf(last, position) >= 0;
}

const utf8 = new TextEncoder();

function normalisePercentEncoding(value: string): string {
  return value.replace(/%[0-9A-Fa-f]{2}|\P{ASCII}+/gu, (match) =>
    match.startsWith("%")
      ? match.toUpperCase()
      : Array.from(
          utf8.encode(match),
          (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
        ).join(""),
  );
}

function robotsDirectives(
  body: string,
): Array<{ field: string; value: string }> {
  const directives: Array<{ field: string; value: string }> = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    directives.push({
      field: line.slice(0, colon).trim().toLowerCase(),
      value: line.slice(colon + 1).trim(),
    });
  }
  return directives;
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

  for (const { field, value } of robotsDirectives(body)) {
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
      pattern: normalisePercentEncoding(value),
    };
    if (agents.includes(ownAgent)) ownRules.push(rule);
    if (agents.includes("*")) starRules.push(rule);
  }

  const rules = namesOwnAgent ? ownRules : starRules;
  return {
    allows: (path: string) => rulesAllow(rules, path),
  };
}

function rulesAllow(rules: RobotsRule[], path: string): boolean {
  const target = normalisePercentEncoding(path);
  let winner: RobotsRule | undefined;
  for (const rule of rules) {
    if (!ruleMatches(rule.pattern, target)) continue;
    if (
      !winner ||
      rule.pattern.length > winner.pattern.length ||
      (rule.pattern.length === winner.pattern.length && rule.allow)
    ) {
      winner = rule;
    }
  }
  return winner?.allow ?? true;
}

export type RobotsAllows = ((pageUrl: string) => Promise<boolean>) & {
  originRefused: boolean;
};

function tagged(
  allows: (pageUrl: string) => Promise<boolean>,
  originRefused: boolean,
): RobotsAllows {
  return Object.assign(allows, { originRefused });
}

export async function fetchRobotsAllows(
  originUrl: string,
  get: (url: string) => Promise<{ status: number; body: string }>,
): Promise<RobotsAllows> {
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
    return tagged(async () => true, false);
  }
  if (res.status < 200 || res.status >= 300) {
    return refuseCrawl(originUrl, `robots.txt returned status ${res.status}`);
  }
  const { allows } = parseRobotsTxt(res.body);
  return tagged(async (pageUrl: string) => {
    const { pathname, search } = new URL(pageUrl);
    const directory = pathname.endsWith("/") ? pathname : `${pathname}/`;
    return allows(`${pathname}${search}`) && allows(`${directory}${search}`);
  }, false);
}

function refuseCrawl(originUrl: string, cause: string): RobotsAllows {
  logger.warn("Website crawl refused: robots.txt unreachable", {
    origin: originUrl,
    cause,
  });
  return tagged(async () => false, true);
}
