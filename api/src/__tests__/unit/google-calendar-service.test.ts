import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
import axios from 'axios';

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
  verifyIdToken: vi.fn(),
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
const credFindOne = vi.fn();
const credUpdate = vi.fn();
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({ save: credSave, findOne: credFindOne, update: credUpdate, create: (x: any) => x }),
    // exchangeAndStore now swaps the credential inside a transaction; route the
    // manager's save/update/create to the same spies so assertions still hold.
    transaction: async (cb: any) => cb({ save: credSave, update: credUpdate, create: (_entity: any, x: any) => x }),
  },
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  validateState,
  getValidAccessToken,
  getGoogleBusyForBot,
  resolveCalendarIdentity,
  exchangeAndStore,
  listWritableCalendars,
  setBotCalendar,
  withGoogleRetry,
  CalendarNotWritableError,
  CalendarNotConnectedError,
} from '../../integrations/google/google-calendar.service';

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
    expect(cred.reauthRequired).toBe(false); // a successful refresh clears any prior flag
    expect(credSave).toHaveBeenCalledOnce();
  });

  it('throws CALENDAR_REAUTH_REQUIRED when expired with no refresh token', async () => {
    const cred: any = { accessTokenEnc: 'enc(old)', refreshTokenEnc: null, tokenExpiry: new Date(Date.now() - 1000) };
    await expect(getValidAccessToken(cred)).rejects.toThrow('CALENDAR_REAUTH_REQUIRED');
    expect(cred.reauthRequired).toBe(true); // flag the dead link so the portal surfaces it
    expect(credSave).toHaveBeenCalledOnce();
  });

  it('flags reauthRequired on a permanent invalid_grant refresh failure', async () => {
    mockClient.getAccessToken.mockRejectedValue({ response: { data: { error: 'invalid_grant' } } });
    const cred: any = { accessTokenEnc: 'enc(old)', refreshTokenEnc: 'enc(refresh)', tokenExpiry: new Date(Date.now() - 1000) };
    await expect(getValidAccessToken(cred)).rejects.toThrow('CALENDAR_REAUTH_REQUIRED');
    expect(cred.reauthRequired).toBe(true);
    expect(credSave).toHaveBeenCalledOnce();
  });

  it('does NOT flag reauthRequired on a transient refresh error (rethrows)', async () => {
    mockClient.getAccessToken.mockRejectedValue(Object.assign(new Error('network'), { code: 'ETIMEDOUT' }));
    const cred: any = { accessTokenEnc: 'enc(old)', refreshTokenEnc: 'enc(refresh)', tokenExpiry: new Date(Date.now() - 1000) };
    await expect(getValidAccessToken(cred)).rejects.toThrow('network');
    expect(cred.reauthRequired).toBeUndefined(); // a blip must not demand a reconnect
    expect(credSave).not.toHaveBeenCalled();
  });

  describe('getGoogleBusyForBot — all-day events', () => {
    it('anchors an all-day (date-only) event to the business timezone, not UTC midnight', async () => {
      credFindOne.mockResolvedValue({
        accessTokenEnc: 'enc(tok)',
        refreshTokenEnc: 'enc(refresh)',
        tokenExpiry: new Date(Date.now() + 10 * 60_000), // valid → no refresh
        calendarId: 'primary',
        status: 'active',
      });
      (axios.get as any).mockResolvedValue({
        data: { items: [{ status: 'confirmed', start: { date: '2026-03-15' }, end: { date: '2026-03-16' } }] },
      });
      // America/New_York is UTC-4 on 2026-03-15 (after DST start), so local midnight = 04:00Z.
      const busy = await getGoogleBusyForBot('bot1', '2026-03-14T00:00:00Z', '2026-03-17T00:00:00Z', 'America/New_York');
      expect(busy).not.toBeNull();
      expect(busy![0].start.toISOString()).toBe('2026-03-15T04:00:00.000Z');
      expect(busy![0].end.toISOString()).toBe('2026-03-16T04:00:00.000Z');
    });

    it('falls back to UTC midnight for a date-only event when no timezone is given', async () => {
      credFindOne.mockResolvedValue({
        accessTokenEnc: 'enc(tok)',
        refreshTokenEnc: 'enc(refresh)',
        tokenExpiry: new Date(Date.now() + 10 * 60_000),
        calendarId: 'primary',
        status: 'active',
      });
      (axios.get as any).mockResolvedValue({
        data: { items: [{ status: 'confirmed', start: { date: '2026-03-15' }, end: { date: '2026-03-16' } }] },
      });
      const busy = await getGoogleBusyForBot('bot1', '2026-03-14T00:00:00Z', '2026-03-17T00:00:00Z');
      expect(busy![0].start.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    });
  });

  describe('resolveCalendarIdentity', () => {
    it('returns null when the bot has no active credential', async () => {
      credFindOne.mockResolvedValue(null);
      expect(await resolveCalendarIdentity('b1')).toBeNull();
    });

    it('resolves a primary calendar to the verified account email', async () => {
      credFindOne.mockResolvedValue({ calendarId: 'primary', accountEmail: 'owner@acme.com' });
      expect(await resolveCalendarIdentity('b1')).toBe('owner@acme.com');
    });

    it('returns null for a legacy primary credential with no account email', async () => {
      credFindOne.mockResolvedValue({ calendarId: 'primary', accountEmail: null });
      expect(await resolveCalendarIdentity('b1')).toBeNull();
    });

    it('uses an explicit non-primary calendarId directly', async () => {
      credFindOne.mockResolvedValue({ calendarId: 'team@group.calendar.google.com', accountEmail: 'owner@acme.com' });
      expect(await resolveCalendarIdentity('b1')).toBe('team@group.calendar.google.com');
    });
  });

  describe('exchangeAndStore — verified account email capture', () => {
    beforeEach(() => {
      mockClient.getToken.mockResolvedValue({
        tokens: { access_token: 'at', refresh_token: 'rt', id_token: 'idtok', expiry_date: Date.now() + 3600_000 },
      });
      credFindOne.mockResolvedValue(null); // no prior cred
    });

    it('stores the email when the id_token is verified and email_verified=true', async () => {
      mockClient.verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: 'owner@acme.com', email_verified: true }) });
      await exchangeAndStore('t1', 'b1', 'code');
      expect(credSave).toHaveBeenCalledWith(expect.objectContaining({ accountEmail: 'owner@acme.com', calendarId: 'primary' }));
    });

    it('leaves accountEmail null when email_verified is not true', async () => {
      mockClient.verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: 'owner@acme.com', email_verified: false }) });
      await exchangeAndStore('t1', 'b1', 'code');
      expect(credSave).toHaveBeenCalledWith(expect.objectContaining({ accountEmail: null }));
    });

    it('leaves accountEmail null when id_token verification throws', async () => {
      mockClient.verifyIdToken.mockRejectedValue(new Error('bad token'));
      await exchangeAndStore('t1', 'b1', 'code');
      expect(credSave).toHaveBeenCalledWith(expect.objectContaining({ accountEmail: null }));
    });
  });

  describe('calendar picker', () => {
    const cred = {
      calendarId: 'primary',
      accountEmail: 'owner@acme.com',
      tokenExpiry: new Date(Date.now() + 3600_000),
      accessTokenEnc: 'enc(tok)',
      refreshTokenEnc: 'enc(r)',
    };
    beforeEach(() => {
      credFindOne.mockResolvedValue(cred);
      (axios.get as any).mockResolvedValue({
        data: {
          items: [
            { id: 'owner@acme.com', summary: 'Owner', primary: true, accessRole: 'owner' },
            { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'writer' },
            { id: 'readonly@group.calendar.google.com', summary: 'Holidays', accessRole: 'reader' },
          ],
        },
      });
    });

    it('lists only writable calendars (owner|writer)', async () => {
      const list = await listWritableCalendars('b1');
      expect(list.map((c) => c.id)).toEqual(['owner@acme.com', 'team@group.calendar.google.com']);
    });

    it('stores an explicit non-primary calendar id', async () => {
      const res = await setBotCalendar('b1', 'team@group.calendar.google.com');
      expect(res.calendarId).toBe('team@group.calendar.google.com');
      expect(credSave).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'team@group.calendar.google.com' }));
    });

    it('canonicalizes the primary calendar to the literal "primary"', async () => {
      // Picking the primary calendar by its real id must store 'primary', not the email.
      const res = await setBotCalendar('b1', 'owner@acme.com');
      expect(res.calendarId).toBe('primary');
      expect(credSave).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'primary' }));
    });

    it('rejects a non-writable / unknown calendar', async () => {
      await expect(setBotCalendar('b1', 'readonly@group.calendar.google.com')).rejects.toBeInstanceOf(CalendarNotWritableError);
    });

    it('throws when the bot has no active calendar credential', async () => {
      credFindOne.mockResolvedValue(null);
      await expect(setBotCalendar('b1', 'primary')).rejects.toBeInstanceOf(CalendarNotConnectedError);
    });
  });

  describe('withGoogleRetry', () => {
    const err = (status: number) => Object.assign(new Error(`http ${status}`), { response: { status } });

    it('retries on 5xx then succeeds', async () => {
      vi.useFakeTimers();
      try {
        const fn = vi.fn().mockRejectedValueOnce(err(503)).mockResolvedValueOnce('ok');
        const p = withGoogleRetry(fn);
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT retry on 4xx (e.g. 409/404)', async () => {
      const fn = vi.fn().mockRejectedValue(err(409));
      await expect(withGoogleRetry(fn)).rejects.toMatchObject({ response: { status: 409 } });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('gives up after the retry budget on persistent 429', async () => {
      vi.useFakeTimers();
      try {
        const fn = vi.fn().mockRejectedValue(err(429));
        const p = withGoogleRetry(fn, 2).catch((e) => e);
        await vi.runAllTimersAsync();
        await p;
        expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
