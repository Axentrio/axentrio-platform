/**
 * Google Calendar — OAuth connect flow + token management (Phase 1, slice #8).
 *
 * The owner connects their Google account; we store encrypted access/refresh
 * tokens against their bot and use the `primary` calendar as both the write
 * destination and busy-check source (v1). Free/busy reads and event writes are
 * added in later slices. Scopes: calendar.events (+ calendar.freebusy).
 */
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../../config/environment';
import { AppDataSource } from '../../database/data-source';
import { CalendarCredential } from '../../database/entities/CalendarCredential';
import { encrypt, decrypt } from '../../utils/encryption';
import { logger } from '../../utils/logger';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];

export class GoogleNotConfiguredError extends Error {
  constructor() {
    super('Google integration is not configured');
    this.name = 'GoogleNotConfiguredError';
  }
}

function oauthClient(): OAuth2Client {
  if (!config.google.clientId || !config.google.clientSecret || !config.google.redirectUri) {
    throw new GoogleNotConfiguredError();
  }
  return new OAuth2Client(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
}

/** Build the consent URL; `state` is a signed JWT binding the connect to a bot. */
export function buildConnectUrl(tenantId: string, botId: string): string {
  const client = oauthClient();
  const state = jwt.sign({ tenantId, botId }, config.google.stateJwtSecret, { expiresIn: '30m' });
  return client.generateAuthUrl({
    access_type: 'offline', // returns a refresh token
    prompt: 'consent', // force refresh-token issuance on reconnect
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export function validateState(state: string): { tenantId: string; botId: string } {
  return jwt.verify(state, config.google.stateJwtSecret) as { tenantId: string; botId: string };
}

/** Exchange the auth code for tokens and persist the credential for the bot. */
export async function exchangeAndStore(tenantId: string, botId: string, code: string): Promise<void> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) {
    throw new Error('Google did not return an access token');
  }

  const repo = AppDataSource.getRepository(CalendarCredential);
  // Replace any existing active credential for this bot (reconnect).
  await repo.update({ botId, provider: 'google', status: 'active' }, { status: 'revoked' });

  const cred = repo.create({
    tenantId,
    botId,
    provider: 'google',
    status: 'active',
    accountEmail: null,
    accessTokenEnc: encrypt(tokens.access_token),
    refreshTokenEnc: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
    tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    calendarId: 'primary',
  });
  await repo.save(cred);
  logger.info('[Google] calendar connected', { botId, hasRefresh: !!tokens.refresh_token });
}

export async function getActiveCredential(botId: string): Promise<CalendarCredential | null> {
  return AppDataSource.getRepository(CalendarCredential).findOne({
    where: { botId, provider: 'google', status: 'active' },
  });
}

/** Return a valid access token, refreshing (and persisting) if expired. */
export async function getValidAccessToken(cred: CalendarCredential): Promise<string> {
  const notExpired = cred.tokenExpiry && cred.tokenExpiry.getTime() - Date.now() > 60_000;
  if (notExpired) return decrypt(cred.accessTokenEnc);

  if (!cred.refreshTokenEnc) {
    throw new Error('CALENDAR_REAUTH_REQUIRED');
  }
  const client = oauthClient();
  client.setCredentials({ refresh_token: decrypt(cred.refreshTokenEnc) });
  // getAccessToken() refreshes when the access token is missing/expired and
  // populates client.credentials with the new token + expiry.
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('CALENDAR_REAUTH_REQUIRED');

  cred.accessTokenEnc = encrypt(token);
  cred.tokenExpiry = client.credentials.expiry_date ? new Date(client.credentials.expiry_date) : null;
  await AppDataSource.getRepository(CalendarCredential).save(cred);
  return token;
}

export async function disconnect(botId: string): Promise<void> {
  const cred = await getActiveCredential(botId);
  if (!cred) return;
  // Best-effort token revocation at Google.
  try {
    const token = decrypt(cred.refreshTokenEnc || cred.accessTokenEnc);
    await axios.post('https://oauth2.googleapis.com/revoke', null, {
      params: { token },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 8000,
    });
  } catch (err) {
    logger.warn('[Google] token revoke failed (continuing)', {
      botId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  cred.status = 'revoked';
  await AppDataSource.getRepository(CalendarCredential).save(cred);
  logger.info('[Google] calendar disconnected', { botId });
}
