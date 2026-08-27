const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Add https when the client types a host without a scheme. */
export function normalizeWebsiteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (!HAS_SCHEME.test(trimmed)) return `https://${trimmed}`;
  return trimmed.replace(/^http:\/\//i, 'https://');
}
