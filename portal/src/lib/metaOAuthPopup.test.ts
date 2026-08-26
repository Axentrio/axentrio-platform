import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  META_OAUTH_MESSAGE_TYPE,
  META_OAUTH_STORAGE_KEY,
  openMetaOAuthPopup,
} from './metaOAuthPopup';

describe('openMetaOAuthPopup', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('falls back to a full-page navigation when the popup is blocked', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: 'https://app.axentrio.com/settings/channels', origin: 'https://app.axentrio.com' },
    });
    // jsdom location.href is often a setter — spy via assignment tracker
    Object.defineProperty(window.location, 'href', {
      configurable: true,
      set: assign,
      get: () => 'https://app.axentrio.com/settings/channels',
    });

    const result = await openMetaOAuthPopup('https://facebook.test/oauth');
    expect(open).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('https://facebook.test/oauth');
    expect(result).toEqual({ status: 'navigated' });
  });

  it('resolves from localStorage written by the closer page', async () => {
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);

    const pending = openMetaOAuthPopup('https://facebook.test/oauth', { timeoutMs: 2000 });
    localStorage.setItem(META_OAUTH_STORAGE_KEY, JSON.stringify({
      type: META_OAUTH_MESSAGE_TYPE,
      sessionToken: 'sess.jwt',
      error: null,
    }));

    await expect(pending).resolves.toEqual({ status: 'ok', sessionToken: 'sess.jwt' });
    expect(localStorage.getItem(META_OAUTH_STORAGE_KEY)).toBeNull();
  });
});
