/** Canonical page identity for a KnowledgeDocument of type url. */
export function canonicalSourceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid website URL");
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

function registrableHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

export function isSameHost(originUrl: string, candidateUrl: string): boolean {
  try {
    const origin = new URL(originUrl);
    const candidate = new URL(candidateUrl);
    return (
      origin.protocol === candidate.protocol &&
      registrableHost(origin.hostname) === registrableHost(candidate.hostname)
    );
  } catch {
    return false;
  }
}
