/**
 * Open Facebook Login in a popup so Settings → Channels never unloads.
 *
 * Facebook Login cannot run in an iframe. The API's Cross-Origin-Opener-Policy
 * also severs window.opener when the popup hits api.axentrio.com, so the closer
 * page writes localStorage (same origin) and this helper consumes it.
 */

export const META_OAUTH_MESSAGE_TYPE = 'axentrio:meta-oauth';
export const META_OAUTH_STORAGE_KEY = 'axentrio:meta-oauth';

export type MetaOAuthPopupResult =
  | { status: 'ok'; sessionToken: string }
  | { status: 'error'; error: string }
  | { status: 'cancelled' }
  | { status: 'navigated' };

interface MetaOAuthMessage {
  type?: unknown;
  sessionToken?: unknown;
  error?: unknown;
}

function readPayload(raw: unknown): MetaOAuthPopupResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as MetaOAuthMessage;
  if (data.type !== META_OAUTH_MESSAGE_TYPE) return null;
  if (typeof data.error === 'string' && data.error) {
    return { status: 'error', error: data.error };
  }
  if (typeof data.sessionToken === 'string' && data.sessionToken) {
    return { status: 'ok', sessionToken: data.sessionToken };
  }
  return { status: 'cancelled' };
}

function consumeStorage(): MetaOAuthPopupResult | null {
  try {
    const raw = localStorage.getItem(META_OAUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const result = readPayload(parsed);
    if (result) localStorage.removeItem(META_OAUTH_STORAGE_KEY);
    return result;
  } catch {
    return null;
  }
}

export function openMetaOAuthPopup(
  url: string,
  options?: { timeoutMs?: number },
): Promise<MetaOAuthPopupResult> {
  if (typeof window === 'undefined') {
    return Promise.resolve({ status: 'error', error: 'unavailable' });
  }

  try {
    localStorage.removeItem(META_OAUTH_STORAGE_KEY);
  } catch {
    /* ignore */
  }

  const popup = window.open(
    url,
    'axentrio-meta-oauth',
    'width=800,height=800,scrollbars=yes,resizable=yes',
  );

  if (!popup) {
    window.location.href = url;
    return Promise.resolve({ status: 'navigated' });
  }

  const timeoutMs = options?.timeoutMs ?? 15 * 60 * 1000;

  return new Promise((resolve) => {
    let settled = false;

    const finish = (result: MetaOAuthPopupResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearInterval(poll);
      window.clearTimeout(timer);
      try {
        if (!popup.closed) popup.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const result = readPayload(event.data);
      if (result) finish(result);
    };

    window.addEventListener('message', onMessage);

    const poll = window.setInterval(() => {
      const stored = consumeStorage();
      if (stored) {
        finish(stored);
        return;
      }
      try {
        if (popup.closed) finish({ status: 'cancelled' });
      } catch {
        /* ignore */
      }
    }, 400);

    const timer = window.setTimeout(() => {
      finish({ status: 'error', error: 'timed_out' });
    }, timeoutMs);
  });
}
