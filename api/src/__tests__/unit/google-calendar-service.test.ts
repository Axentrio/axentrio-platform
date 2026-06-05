import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('../../config/environment', () => ({
  config: {
    google: {
      clientId: 'cid',
      clientSecret: 'sec',
      redirectUri: 'https://api/cb',
      stateJwtSecret: 'test-secret',
    },
  },
}));

const mockClient: any = {
  setCredentials: vi.fn(),
  getAccessToken: vi.fn(),
  generateAuthUrl: vi.fn(() => 'https://accounts.google.com/o/oauth2/auth?state=x'),
  getToken: vi.fn(),
  credentials: {},
};
vi.mock('google-auth-library', () => ({
  // Regular function so it is usable with `new` (returns the shared mock client).
  OAuth2Client: vi.fn(function () {
    return mockClient;
  }),
}));

vi.mock('../../utils/encryption', () => ({
  encrypt: (x: string) => `enc(${x})`,
  decrypt: (x: string) => (x.startsWith('enc(') ? x.slice(4, -1) : x),
}));

const credSave = vi.fn();
vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ save: credSave }) },
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { validateState, getValidAccessToken } from '../../integrations/google/google-calendar.service';

describe('google-calendar.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.credentials = {};
  });

  it('validates a signed connect state', () => {
    const state = jwt.sign({ tenantId: 't1', botId: 'b1' }, 'test-secret');
    expect(validateState(state)).toMatchObject({ tenantId: 't1', botId: 'b1' });
  });

  it('rejects a tampered state', () => {
    expect(() => validateState('not-a-jwt')).toThrow();
  });

  it('returns the cached access token when not expired (no refresh)', async () => {
    const cred: any = {
      accessTokenEnc: 'enc(cached-token)',
      refreshTokenEnc: 'enc(refresh)',
      tokenExpiry: new Date(Date.now() + 10 * 60_000),
    };
    const token = await getValidAccessToken(cred);
    expect(token).toBe('cached-token');
    expect(mockClient.getAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes and persists when the token is expired', async () => {
    mockClient.getAccessToken.mockImplementation(async () => {
      mockClient.credentials.expiry_date = Date.now() + 3600_000;
      return { token: 'fresh-token' };
    });
    const cred: any = {
      accessTokenEnc: 'enc(old)',
      refreshTokenEnc: 'enc(refresh)',
      tokenExpiry: new Date(Date.now() - 1000),
    };
    const token = await getValidAccessToken(cred);
    expect(token).toBe('fresh-token');
    expect(cred.accessTokenEnc).toBe('enc(fresh-token)');
    expect(credSave).toHaveBeenCalledOnce();
  });

  it('throws CALENDAR_REAUTH_REQUIRED when expired with no refresh token', async () => {
    const cred: any = { accessTokenEnc: 'enc(old)', refreshTokenEnc: null, tokenExpiry: new Date(Date.now() - 1000) };
    await expect(getValidAccessToken(cred)).rejects.toThrow('CALENDAR_REAUTH_REQUIRED');
  });
});
