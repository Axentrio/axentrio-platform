const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** User-typed website: add https when the scheme is missing, then canonicalize. */
export function normalizeWebsiteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Invalid website URL");
  let candidate = trimmed;
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  else if (!HAS_SCHEME.test(candidate)) candidate = `https://${candidate}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Invalid website URL");
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") {
    throw new Error("Invalid website URL");
  }
  return canonicalSourceUrl(url.toString());
}

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

const MEDIA_PATH =
  /\.(?:jpe?g|png|gif|webp|svg|ico|pdf|zip|mp4|mp3|webm|woff2?|ttf|css|js|map|json)$/i;

/** True for gallery/media files that must not fill crawl slots. */
export function isMediaUrl(raw: string): boolean {
  try {
    return MEDIA_PATH.test(new URL(raw).pathname);
  } catch {
    return true;
  }
}

export function originFromSourceUrl(sourceUrl: string): string | null {
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}
