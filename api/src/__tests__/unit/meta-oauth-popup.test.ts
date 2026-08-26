import { describe, expect, it } from 'vitest';
import {
  buildMetaOAuthCompleteUrl,
  buildMetaOAuthPageUrl,
  sanitizeMetaOAuthDisplay,
  sanitizeMetaOAuthReturnPath,
} from '../../channels/meta/oauth-popup';

describe('meta oauth popup helpers', () => {
  it('allows only known return paths', () => {
    expect(sanitizeMetaOAuthReturnPath('/setup')).toBe('/setup');
    expect(sanitizeMetaOAuthReturnPath('/settings/channels')).toBe('/settings/channels');
    expect(sanitizeMetaOAuthReturnPath('https://evil.example/phish')).toBe('/settings/channels');
    expect(sanitizeMetaOAuthReturnPath('//evil.example')).toBe('/settings/channels');
  });

  it('defaults display to popup', () => {
    expect(sanitizeMetaOAuthDisplay(undefined)).toBe('popup');
    expect(sanitizeMetaOAuthDisplay('page')).toBe('page');
    expect(sanitizeMetaOAuthDisplay('iframe')).toBe('popup');
  });

  it('builds the closer URL for popup callbacks', () => {
    const url = buildMetaOAuthCompleteUrl('https://app.axentrio.com', {
      sessionToken: 'sess.jwt',
      returnPath: '/setup',
      display: 'popup',
    });
    expect(url).toBe(
      'https://app.axentrio.com/meta-oauth-complete.html?meta_setup=sess.jwt&return=%2Fsetup&popup=1',
    );
  });

  it('builds a same-tab fallback URL', () => {
    const url = buildMetaOAuthPageUrl('https://app.axentrio.com', {
      error: 'denied',
      returnPath: '/settings/channels',
    });
    expect(url).toBe('https://app.axentrio.com/settings/channels?error=denied');
  });
});
