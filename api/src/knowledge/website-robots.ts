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
