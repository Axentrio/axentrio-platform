/**
 * P6b — Microsoft/Outlook calendar OAuth service.
 *
 * Pins the connect-state provider scoping, the single-active switch in
 * exchangeAndStore (revoke any active cred → insert Microsoft with account_id →
 * rekey to mscal:<id>), and the advisory-lock token refresh with refresh-token
 * rotation + reauth_required handling.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
import axios from 'axios';

vi.mock('../../config/environment', () => ({
  config: {
    microsoft: {
      clientId: 'ms-cid',
      clientSecret: 'ms-sec',
      redirectUri: 'https://api/outlook/cb',
      stateJwtSecret: 'test-secret',
    },
  },
}));

vi.mock('../../utils/encryption', () => ({
  encrypt: (x: string) => `enc(${x})`,
  decrypt: (x: string) => (x.startsWith('enc(') ? x.slice(4, -1) : x),
}));

const repoFindOne = vi.fn();
const repoSave = vi.fn();
const mgrQuery = vi.fn();
const mgrFindOne = vi.fn();
const mgrSave = vi.fn();
const mgrUpdate = vi.fn();
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({ findOne: repoFindOne, save: repoSave, create: (x: any) => x }),
    transaction: async (cb: any) =>
      cb({
        query: mgrQuery,
        findOne: mgrFindOne,
        save: mgrSave,
        update: mgrUpdate,
        // TypeORM EntityManager.create(EntityClass, data) → return the data object.
        create: (_cls: any, data: any) => data,
      }),
  },
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { rekeyBotBookings } = vi.hoisted(() => ({ rekeyBotBookings: vi.fn() }));
vi.mock('../../scheduler/calendar-rekey', async (orig) => ({
  ...(await (orig as () => Promise<object>)()),
  rekeyBotBookings,
}));

import {
  buildConnectUrl,
  validateState,
  exchangeAndStore,
  getValidAccessTokenMicrosoft,
  MicrosoftNotConfiguredError,
} from '../../integrations/microsoft/outlook-calendar.service';

beforeEach(() => {
  vi.clearAllMocks();
  rekeyBotBookings.mockResolvedValue(undefined);
});

describe('connect state', () => {
  it('mints a state carrying provider:microsoft', () => {
    const url = new URL(buildConnectUrl('t1', 'b1'));
    const state = url.searchParams.get('state')!;
    expect(jwt.verify(state, 'test-secret')).toMatchObject({ tenantId: 't1', botId: 'b1', provider: 'microsoft' });
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('ms-cid');
  });

  it('validateState accepts a microsoft state and rejects a non-microsoft one', () => {
    const ms = jwt.sign({ tenantId: 't1', botId: 'b1', provider: 'microsoft' }, 'test-secret');
    expect(validateState(ms)).toEqual({ tenantId: 't1', botId: 'b1' });
    const google = jwt.sign({ tenantId: 't1', botId: 'b1', provider: 'google' }, 'test-secret');
    expect(() => validateState(google)).toThrow(/provider mismatch/);
    const noProvider = jwt.sign({ tenantId: 't1', botId: 'b1' }, 'test-secret');
    expect(() => validateState(noProvider)).toThrow(/provider mismatch/);
  });
});

describe('buildConnectUrl when unconfigured', () => {
  it('throws MicrosoftNotConfiguredError', async () => {
    const { config } = await import('../../config/environment');
    const saved = config.microsoft.clientId;
    (config.microsoft as any).clientId = '';
    expect(() => buildConnectUrl('t1', 'b1')).toThrow(MicrosoftNotConfiguredError);
    (config.microsoft as any).clientId = saved;
  });
});

describe('exchangeAndStore', () => {
  it('revokes any active cred, stores microsoft with account_id, and rekeys to mscal:<id>', async () => {
    (axios.post as any).mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('login.microsoftonline.com')) {
        return { data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } };
      }
      return { data: {} }; // displaced-Google revoke
    });
    (axios.get as any).mockResolvedValue({ data: { id: 'ms-oid-1', mail: 'owner@acme.com' } });
    repoFindOne.mockResolvedValue({ provider: 'google', refreshTokenEnc: 'enc(grt)' }); // prior active

    await exchangeAndStore('t1', 'b1', 'auth-code');

    // single-active swap: revoke all active for bot, then insert the new one
    expect(mgrUpdate).toHaveBeenCalledWith(expect.anything(), { botId: 'b1', status: 'active' }, { status: 'revoked' });
    const saved = mgrSave.mock.calls[0][0];
    expect(saved).toMatchObject({
      provider: 'microsoft',
      status: 'active',
      accountId: 'ms-oid-1',
      accountEmail: 'owner@acme.com',
      reauthRequired: false,
      accessTokenEnc: 'enc(at)',
      refreshTokenEnc: 'enc(rt)',
    });
    expect(rekeyBotBookings).toHaveBeenCalledWith('b1', 'mscal:ms-oid-1');
  });

  it('throws when Graph /me returns no id', async () => {
    (axios.post as any).mockResolvedValue({ data: { access_token: 'at', expires_in: 3600 } });
    (axios.get as any).mockResolvedValue({ data: { mail: 'x@y.com' } }); // no id
    repoFindOne.mockResolvedValue(null);
    await expect(exchangeAndStore('t1', 'b1', 'code')).rejects.toThrow(/no account id/);
  });
});

describe('getValidAccessTokenMicrosoft', () => {
  it('fast-path returns the cached token without a transaction when not expired', async () => {
    const cred: any = {
      id: 'c1',
      botId: 'b1',
      accessTokenEnc: 'enc(cached)',
      tokenExpiry: new Date(Date.now() + 10 * 60_000),
      reauthRequired: false,
    };
    expect(await getValidAccessTokenMicrosoft(cred)).toBe('cached');
    expect(mgrQuery).not.toHaveBeenCalled();
  });

  it('refreshes under the advisory lock and rotates the refresh token', async () => {
    const cred: any = { id: 'c1', botId: 'b1', tokenExpiry: new Date(Date.now() - 1000) };
    mgrFindOne.mockResolvedValue({
      id: 'c1',
      botId: 'b1',
      status: 'active',
      reauthRequired: false,
      refreshTokenEnc: 'enc(old-refresh)',
      tokenExpiry: new Date(Date.now() - 1000),
    });
    (axios.post as any).mockResolvedValue({
      data: { access_token: 'new-at', refresh_token: 'rotated-rt', expires_in: 3600 },
    });

    const token = await getValidAccessTokenMicrosoft(cred);
    expect(token).toBe('new-at');
    expect(mgrQuery).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['calcred:b1']);
    const persisted = mgrSave.mock.calls[0][0];
    expect(persisted.accessTokenEnc).toBe('enc(new-at)');
    expect(persisted.refreshTokenEnc).toBe('enc(rotated-rt)'); // rotation persisted
    expect(persisted.reauthRequired).toBe(false);
  });

  it('sets reauth_required and throws on invalid_grant', async () => {
    const cred: any = { id: 'c1', botId: 'b1', tokenExpiry: new Date(Date.now() - 1000) };
    const row = {
      id: 'c1',
      botId: 'b1',
      status: 'active',
      reauthRequired: false,
      refreshTokenEnc: 'enc(old-refresh)',
      tokenExpiry: new Date(Date.now() - 1000),
    };
    mgrFindOne.mockResolvedValue(row);
    (axios.post as any).mockRejectedValue({ response: { data: { error: 'invalid_grant' } } });

    await expect(getValidAccessTokenMicrosoft(cred)).rejects.toThrow('CALENDAR_REAUTH_REQUIRED');
    expect(row.reauthRequired).toBe(true);
    expect(mgrSave).toHaveBeenCalledWith(expect.objectContaining({ reauthRequired: true }));
  });
});
