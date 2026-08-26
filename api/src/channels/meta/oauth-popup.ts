/**
 * Facebook Login cannot run in an iframe (X-Frame-Options / frame-ancestors).
 * Axentrio opens a popup instead, then lands on a same-origin closer page so
 * the Channels UI never unloads.
 *
 * The API also sends Cross-Origin-Opener-Policy: same-origin, which severs
 * window.opener when the popup hits this host. The closer page therefore
 * writes localStorage (same origin as the portal) as the source of truth;
 * postMessage is a best-effort extra.
 */

export const META_OAUTH_MESSAGE_TYPE = 'axentrio:meta-oauth';
export const META_OAUTH_STORAGE_KEY = 'axentrio:meta-oauth';
export const META_OAUTH_COMPLETE_PATH = '/meta-oauth-complete.html';

export const META_OAUTH_ALLOWED_RETURN_PATHS = [
  '/settings/channels',
  '/setup',
] as const;

export type MetaOAuthDisplay = 'popup' | 'page';

export function sanitizeMetaOAuthReturnPath(raw: unknown): string {
  if (typeof raw !== 'string') return '/settings/channels';
  return (META_OAUTH_ALLOWED_RETURN_PATHS as readonly string[]).includes(raw)
    ? raw
    : '/settings/channels';
}

export function sanitizeMetaOAuthDisplay(raw: unknown): MetaOAuthDisplay {
  return raw === 'page' ? 'page' : 'popup';
}

export function portalOrigin(portalUrl: string): string {
  try {
    return new URL(portalUrl).origin;
  } catch {
    return 'http://localhost:4080';
  }
}

export function buildMetaOAuthCompleteUrl(
  portalUrl: string,
  params: {
    sessionToken?: string;
    error?: string;
    returnPath?: string;
    display?: MetaOAuthDisplay;
  },
): string {
  const origin = portalOrigin(portalUrl);
  const query = new URLSearchParams();
  if (params.sessionToken) query.set('meta_setup', params.sessionToken);
  if (params.error) query.set('error', params.error);
  query.set('return', sanitizeMetaOAuthReturnPath(params.returnPath));
  if (params.display === 'popup') query.set('popup', '1');
  return `${origin}${META_OAUTH_COMPLETE_PATH}?${query.toString()}`;
}

export function buildMetaOAuthPageUrl(
  portalUrl: string,
  params: {
    sessionToken?: string;
    error?: string;
    returnPath?: string;
  },
): string {
  const origin = portalOrigin(portalUrl);
  const path = sanitizeMetaOAuthReturnPath(params.returnPath);
  const query = new URLSearchParams();
  if (params.sessionToken) query.set('meta_setup', params.sessionToken);
  if (params.error) query.set('error', params.error);
  const qs = query.toString();
  return qs ? `${origin}${path}?${qs}` : `${origin}${path}`;
}
