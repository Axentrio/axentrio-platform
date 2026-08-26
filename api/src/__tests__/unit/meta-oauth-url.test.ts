import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('../../config/environment', () => ({
  config: {
    meta: {
      appId: '1548698999932589',
      appSecret: 'secret',
      oauthRedirectUri: 'https://api.axentrio.com/api/v1/channels/meta/oauth/callback',
      oauthJwtSecret: 'unit-meta-oauth-jwt-secret-32chars!!',
    },
  },
}));

vi.mock('../../config/redis', () => ({
  getRedisClient: vi.fn(() => null),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildOAuthUrl, validateOAuthState } from '../../channels/meta/oauth.service';

describe('buildOAuthUrl', () => {
  it('requests a popup dialog and encodes display + returnPath in state', () => {
    const url = buildOAuthUrl('tenant-1', { display: 'popup', returnPath: '/setup' });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://www.facebook.com/v25.0/dialog/oauth');
    expect(parsed.searchParams.get('display')).toBe('popup');
    expect(parsed.searchParams.get('scope')).not.toContain('whatsapp');
    const state = validateOAuthState(parsed.searchParams.get('state') as string);
    expect(state).toMatchObject({
      tenantId: 'tenant-1',
      display: 'popup',
      returnPath: '/setup',
    });
    expect(jwt.decode(parsed.searchParams.get('state') as string)).toMatchObject({ tenantId: 'tenant-1' });
  });
});
