/**
 * Microsoft / Outlook Calendar — OAuth connect flow + token management (P6b).
 *
 * Mirrors the Google service: the owner connects their Microsoft account; we
 * store encrypted access/refresh tokens against their bot and use the default
 * calendar as both write destination and busy-check source. Identity is the
 * Graph user object id (`/me` `id`) — stable across email/UPN aliasing — kept in
 * `CalendarCredential.account_id` and used for the `mscal:<account_id>` conflict
 * key. Event CRUD + free/busy land in P6c; this slice is connect/switch/refresh.
 *
 * At-most-one active credential per bot (any provider): connecting Outlook
 * revokes whatever provider was active, in one transaction.
 */
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { config } from '../../config/environment';
import { AppDataSource } from '../../database/data-source';
import { CalendarCredential } from '../../database/entities/CalendarCredential';
import { encrypt, decrypt } from '../../utils/encryption';
import { logger } from '../../utils/logger';
import { conflictKeyFor, rekeyBotBookings } from '../../scheduler/calendar-rekey';

const AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me';

// offline_access → refresh token; Calendars.ReadWrite → events + calendarView
// free/busy; User.Read → /me identity; openid/email → consent UX.
const SCOPES = ['offline_access', 'openid', 'email', 'User.Read', 'Calendars.ReadWrite'];
const SCOPE_PARAM = SCOPES.join(' ');

export class MicrosoftNotConfiguredError extends Error {
  constructor() {
    super('Microsoft integration is not configured');
    this.name = 'MicrosoftNotConfiguredError';
  }
}

function ensureConfigured(): void {
  if (!config.microsoft.clientId || !config.microsoft.clientSecret || !config.microsoft.redirectUri) {
    throw new MicrosoftNotConfiguredError();
  }
}

export function isMicrosoftConfigured(): boolean {
  return !!(config.microsoft.clientId && config.microsoft.clientSecret && config.microsoft.redirectUri);
}

interface MsTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

/** POST the Microsoft token endpoint (form-encoded). */
async function msTokenRequest(extra: Record<string, string>): Promise<MsTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    redirect_uri: config.microsoft.redirectUri,
    scope: SCOPE_PARAM,
    ...extra,
  });
  const resp = await axios.post(TOKEN_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 12000,
  });
  return resp.data as MsTokenResponse;
}

/** True when a token request failed because the refresh token / consent is gone
 *  (owner-actionable reauth), vs a transient error (caller retries). */
function isInvalidGrant(err: unknown): boolean {
  const data = (err as { response?: { data?: { error?: string } } })?.response?.data;
  return data?.error === 'invalid_grant';
}

/** Build the consent URL; `state` is a signed JWT binding the connect to a bot,
 *  carrying `provider:'microsoft'` so it can't be replayed against the Google
 *  callback. */
export function buildConnectUrl(tenantId: string, botId: string): string {
  ensureConfigured();
  const state = jwt.sign(
    { tenantId, botId, provider: 'microsoft' },
    config.microsoft.stateJwtSecret,
    { expiresIn: '30m' }
  );
  const params = new URLSearchParams({
    client_id: config.microsoft.clientId,
    response_type: 'code',
    redirect_uri: config.microsoft.redirectUri,
    response_mode: 'query',
    scope: SCOPE_PARAM,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function validateState(state: string): { tenantId: string; botId: string } {
  const claims = jwt.verify(state, config.microsoft.stateJwtSecret) as {
    tenantId: string;
    botId: string;
    provider?: string;
  };
  if (claims.provider !== 'microsoft') {
    throw new Error('calendar connect state provider mismatch');
  }
  return { tenantId: claims.tenantId, botId: claims.botId };
}

export async function getActiveCredential(botId: string): Promise<CalendarCredential | null> {
  return AppDataSource.getRepository(CalendarCredential).findOne({
    where: { botId, provider: 'microsoft', status: 'active' },
  });
}

/** Exchange the auth code for tokens, read the Graph identity, and store the
 *  credential — revoking ANY currently-active credential for the bot (any
 *  provider) in the same transaction so the single-active invariant holds. */
export async function exchangeAndStore(tenantId: string, botId: string, code: string): Promise<void> {
  ensureConfigured();
  const tokens = await msTokenRequest({ grant_type: 'authorization_code', code });
  if (!tokens.access_token) throw new Error('Microsoft did not return an access token');

  // Graph identity: stable object id + best-effort email.
  const me = await axios.get(GRAPH_ME_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    timeout: 12000,
  });
  const accountId: string | null = me.data?.id ?? null;
  const accountEmail: string | null = me.data?.mail ?? me.data?.userPrincipalName ?? null;
  if (!accountId) throw new Error('Microsoft Graph /me returned no account id');

  // Capture the prior active cred (any provider) for best-effort token revocation
  // after the swap commits.
  const repo = AppDataSource.getRepository(CalendarCredential);
  const prior = await repo.findOne({ where: { botId, status: 'active' } });

  await AppDataSource.transaction(async (manager) => {
    // Revoke whatever is active for this bot (Google OR a stale Microsoft row),
    // then insert the new active Microsoft credential — single-active per bot.
    await manager.update(CalendarCredential, { botId, status: 'active' }, { status: 'revoked' });
    await manager.save(
      manager.create(CalendarCredential, {
        tenantId,
        botId,
        provider: 'microsoft',
        status: 'active',
        accountId,
        accountEmail,
        reauthRequired: false,
        accessTokenEnc: encrypt(tokens.access_token),
        refreshTokenEnc: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        tokenExpiry: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
        calendarId: 'primary',
      })
    );
  });

  logger.info('[Outlook] calendar connected', {
    botId,
    hasRefresh: !!tokens.refresh_token,
    switchedFrom: prior && prior.provider !== 'microsoft' ? prior.provider : undefined,
  });

  // If we switched away from another provider, best-effort revoke its token at
  // the source (Microsoft refresh tokens are revoked via reconnect/consent, so we
  // only attempt this for a displaced Google credential).
  if (prior && prior.provider === 'google') {
    try {
      const token = decrypt(prior.refreshTokenEnc || prior.accessTokenEnc);
      await axios.post('https://oauth2.googleapis.com/revoke', null, {
        params: { token },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000,
      });
    } catch (err) {
      logger.warn('[Outlook] displaced Google token revoke failed (continuing)', {
        botId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Rekey this bot's active future bookings to the Microsoft conflict key.
  await rekeyBotBookings(botId, conflictKeyFor(botId, accountId, 'microsoft')).catch((err) =>
    logger.warn('[Outlook] post-connect rekey failed (non-fatal)', {
      botId,
      error: err instanceof Error ? err.message : String(err),
    })
  );
}

/**
 * Return a valid access token, refreshing (and persisting the ROTATED refresh
 * token) if expired. The read-recheck-refresh-persist runs under the per-bot
 * `calcred:<botId>` advisory lock so it serializes with reconnect/disconnect and
 * a concurrent refresh can't double-rotate the refresh token. Throws
 * `CALENDAR_REAUTH_REQUIRED` (and sets `reauth_required`) when consent is gone.
 */
export async function getValidAccessTokenMicrosoft(cred: CalendarCredential): Promise<string> {
  if (
    !cred.reauthRequired &&
    cred.tokenExpiry &&
    cred.tokenExpiry.getTime() - Date.now() > 60_000
  ) {
    return decrypt(cred.accessTokenEnc);
  }

  return AppDataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`calcred:${cred.botId}`]);
    // Re-read under the lock — a concurrent refresh/reconnect may have updated it.
    const fresh = await manager.findOne(CalendarCredential, { where: { id: cred.id } });
    if (!fresh || fresh.status !== 'active' || fresh.reauthRequired) {
      throw new Error('CALENDAR_REAUTH_REQUIRED');
    }
    if (fresh.tokenExpiry && fresh.tokenExpiry.getTime() - Date.now() > 60_000) {
      return decrypt(fresh.accessTokenEnc);
    }
    if (!fresh.refreshTokenEnc) {
      fresh.reauthRequired = true;
      await manager.save(fresh);
      throw new Error('CALENDAR_REAUTH_REQUIRED');
    }
    try {
      const tok = await msTokenRequest({
        grant_type: 'refresh_token',
        refresh_token: decrypt(fresh.refreshTokenEnc),
      });
      if (!tok.access_token) throw new Error('no access token in refresh response');
      fresh.accessTokenEnc = encrypt(tok.access_token);
      if (tok.refresh_token) fresh.refreshTokenEnc = encrypt(tok.refresh_token); // rotation
      fresh.tokenExpiry = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000);
      fresh.reauthRequired = false;
      await manager.save(fresh);
      return tok.access_token;
    } catch (err) {
      if (isInvalidGrant(err)) {
        fresh.reauthRequired = true;
        await manager.save(fresh);
        throw new Error('CALENDAR_REAUTH_REQUIRED');
      }
      throw err; // transient — caller backs off / retries
    }
  });
}

/** Account-unique identity for the conflict key: the Graph object id. */
export async function resolveOutlookIdentity(botId: string): Promise<string | null> {
  const cred = await getActiveCredential(botId);
  return cred?.accountId ?? null;
}

export interface OutlookStatus {
  connected: boolean;
  accountEmail: string | null;
  calendarId: string | null;
  needsReauth: boolean;
}

export async function getStatus(botId: string): Promise<OutlookStatus> {
  const cred = await getActiveCredential(botId);
  if (!cred) return { connected: false, accountEmail: null, calendarId: null, needsReauth: false };
  return {
    connected: true,
    accountEmail: cred.accountEmail ?? null,
    calendarId: cred.calendarId,
    needsReauth: cred.reauthRequired,
  };
}

export async function disconnect(botId: string): Promise<void> {
  const cred = await getActiveCredential(botId);
  if (!cred) return;
  cred.status = 'revoked';
  await AppDataSource.getRepository(CalendarCredential).save(cred);
  logger.info('[Outlook] calendar disconnected', { botId });

  // No active calendar anymore → fall back to the bot-scoped conflict key.
  await rekeyBotBookings(botId, conflictKeyFor(botId, null)).catch((err) =>
    logger.warn('[Outlook] post-disconnect rekey failed (non-fatal)', {
      botId,
      error: err instanceof Error ? err.message : String(err),
    })
  );
}
