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
import { conflictKeyFor, rekeyBotBookings } from '../../scheduler/calendar-rekey';

// Scopes:
// - calendar.events: read events (busy via events.list) + write them.
// - calendar.calendarlist.readonly: list the account's calendars for the picker
//   (narrowest scope that allows CalendarList.list).
// - openid/email: returns a verified id_token whose email is the connected
//   account identity (used for the normalized conflict key + "which account?" UX).
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
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

/**
 * Retry a Google Calendar API call on transient failures (HTTP 429 / 5xx) with
 * bounded exponential backoff. Non-retryable statuses (4xx like 403/404/409) are
 * rethrown immediately so callers keep their existing handling. Exported for tests.
 */
export async function withGoogleRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const retryable = status === 429 || (status !== undefined && status >= 500 && status < 600);
      if (!retryable || attempt >= retries) throw err;
      const delayMs = Math.min(2000, 200 * 2 ** attempt);
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Build the consent URL; `state` is a signed JWT binding the connect to a bot. */
export function buildConnectUrl(tenantId: string, botId: string): string {
  const client = oauthClient();
  const state = jwt.sign(
    { tenantId, botId, provider: 'google' },
    config.google.stateJwtSecret,
    { expiresIn: '30m' }
  );
  return client.generateAuthUrl({
    access_type: 'offline', // returns a refresh token
    prompt: 'consent', // force refresh-token issuance on reconnect
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export function validateState(state: string): { tenantId: string; botId: string } {
  const claims = jwt.verify(state, config.google.stateJwtSecret) as {
    tenantId: string;
    botId: string;
    provider?: string;
  };
  // Reject a Microsoft-minted state replayed against the Google callback. Older
  // Google states carry no `provider` claim, so only an explicit mismatch fails.
  if (claims.provider && claims.provider !== 'google') {
    throw new Error('calendar connect state provider mismatch');
  }
  return { tenantId: claims.tenantId, botId: claims.botId };
}

/**
 * Extract the VERIFIED account email from a Google id_token. Returns the email
 * only when the token verifies against our client id AND `email_verified` is
 * true — an unverified email must never become the primary-calendar identity.
 */
async function verifiedEmailFromIdToken(idToken: string | null | undefined): Promise<string | null> {
  if (!idToken) return null;
  try {
    const client = oauthClient();
    const ticket = await client.verifyIdToken({ idToken, audience: config.google.clientId! });
    const payload = ticket.getPayload();
    if (payload?.email && payload.email_verified === true) return payload.email;
  } catch (err) {
    logger.warn('[Google] id_token verification failed; account email unknown', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

/** Exchange the auth code for tokens and persist the credential for the bot. */
export async function exchangeAndStore(tenantId: string, botId: string, code: string): Promise<void> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) {
    throw new Error('Google did not return an access token');
  }
  // Always recompute the account email from THIS connection's verified id_token;
  // never carry forward a prior credential's email (a reconnect may be a
  // different account).
  const accountEmail = await verifiedEmailFromIdToken(tokens.id_token);

  // Preserve a previously-picked non-`primary` calendarId across reconnect ONLY
  // when it is still writable under the newly-connected account; otherwise reset
  // to `primary`. (Writability is validated by the picker layer; here we keep it
  // simple — same account email + prior non-primary id is preserved, else reset.)
  const repo = AppDataSource.getRepository(CalendarCredential);
  const prior = await repo.findOne({ where: { botId, provider: 'google', status: 'active' } });
  const preservedCalendarId =
    prior &&
    prior.calendarId &&
    prior.calendarId !== 'primary' &&
    prior.accountEmail &&
    accountEmail &&
    prior.accountEmail === accountEmail
      ? prior.calendarId
      : 'primary';

  // Replace any existing active credential for this bot (reconnect).
  await repo.update({ botId, provider: 'google', status: 'active' }, { status: 'revoked' });

  const cred = repo.create({
    tenantId,
    botId,
    provider: 'google',
    status: 'active',
    accountEmail,
    accessTokenEnc: encrypt(tokens.access_token),
    refreshTokenEnc: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
    tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    calendarId: preservedCalendarId,
  });
  await repo.save(cred);
  logger.info('[Google] calendar connected', {
    botId,
    hasRefresh: !!tokens.refresh_token,
    hasEmail: !!accountEmail,
    calendarId: preservedCalendarId,
  });

  // Identity may have changed (first connect / reconnect / different account) —
  // rekey this bot's active future bookings to the normalized conflict key.
  const identity = preservedCalendarId !== 'primary' ? preservedCalendarId : accountEmail;
  await rekeyBotBookings(botId, conflictKeyFor(botId, identity)).catch((err) =>
    logger.warn('[Google] post-connect rekey failed (non-fatal)', {
      botId,
      error: err instanceof Error ? err.message : String(err),
    })
  );
}

/**
 * Account-unique identity for the bot's connected calendar, or null if unknown.
 * A `primary` calendar resolves to the stored verified account email; an explicit
 * non-`primary` calendarId is itself account-unique. Legacy creds (email unknown
 * + primary) return null → callers fall back to the bot-scoped key. This is the
 * single source for the conflict `calendar_key` and never the literal `primary`.
 */
export async function resolveCalendarIdentity(botId: string): Promise<string | null> {
  const cred = await getActiveCredential(botId);
  if (!cred) return null;
  if (cred.calendarId && cred.calendarId !== 'primary') return cred.calendarId;
  return cred.accountEmail ?? null;
}

export async function getActiveCredential(botId: string): Promise<CalendarCredential | null> {
  return AppDataSource.getRepository(CalendarCredential).findOne({
    where: { botId, provider: 'google', status: 'active' },
  });
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

/**
 * List the connected account's WRITABLE calendars (accessRole owner|writer) for
 * the picker. Returns [] when the bot has no active connection. Needs the
 * calendar.calendarlist.readonly scope (added in this release; older creds must
 * reconnect to grant it).
 */
export async function listWritableCalendars(botId: string): Promise<CalendarListEntry[]> {
  const cred = await getActiveCredential(botId);
  if (!cred) return [];
  const accessToken = await getValidAccessToken(cred);
  const resp = await withGoogleRetry(() =>
    axios.get('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      params: { minAccessRole: 'writer', maxResults: 250 },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000,
    })
  );
  const items: Array<{
    id: string;
    summary?: string;
    summaryOverride?: string;
    primary?: boolean;
    accessRole?: string;
  }> = resp.data?.items || [];
  return items
    .filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer')
    .map((c) => ({
      id: c.id,
      summary: c.summaryOverride || c.summary || c.id,
      primary: !!c.primary,
      accessRole: c.accessRole!,
    }));
}

export class CalendarNotConnectedError extends Error {
  constructor() {
    super('Calendar is not connected');
    this.name = 'CalendarNotConnectedError';
  }
}
export class CalendarNotWritableError extends Error {
  constructor() {
    super('Selected calendar is not writable');
    this.name = 'CalendarNotWritableError';
  }
}

/**
 * Set the bot's write-target calendar. Validates the choice is writable under the
 * connected account and canonicalizes the primary calendar to the literal
 * `'primary'` (never stores the primary's email/id, which would bypass the
 * verified-id_token identity rule). Triggers a rekey of active future bookings.
 */
export async function setBotCalendar(botId: string, calendarId: string): Promise<{ calendarId: string }> {
  const cred = await getActiveCredential(botId);
  if (!cred) throw new CalendarNotConnectedError();
  const writable = await listWritableCalendars(botId);
  const chosen = writable.find((c) => c.id === calendarId || (calendarId === 'primary' && c.primary));
  if (!chosen) throw new CalendarNotWritableError();

  const newCalendarId = chosen.primary ? 'primary' : chosen.id;
  cred.calendarId = newCalendarId;
  await AppDataSource.getRepository(CalendarCredential).save(cred);

  const identity = newCalendarId !== 'primary' ? newCalendarId : cred.accountEmail ?? null;
  await rekeyBotBookings(botId, conflictKeyFor(botId, identity)).catch((err) =>
    logger.warn('[Google] post-picker rekey failed (non-fatal)', {
      botId,
      error: err instanceof Error ? err.message : String(err),
    })
  );
  return { calendarId: newCalendarId };
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

export interface GoogleBusyInterval {
  start: Date;
  end: Date;
}

/**
 * Busy intervals from the bot's connected Google calendar for [startISO,endISO).
 * Returns null when the bot has no active Google connection (internal-only).
 * Throws on API/token failure so callers can fail-closed rather than offering
 * slots that might collide with real events.
 */
export async function getGoogleBusyForBot(
  botId: string,
  startISO: string,
  endISO: string
): Promise<GoogleBusyInterval[] | null> {
  const cred = await getActiveCredential(botId);
  if (!cred) return null;

  // Google's events.list requires RFC3339 timestamps for timeMin/timeMax and
  // 400s on date-only or no-offset values (which upstream callers may pass).
  // Coerce to a canonical ISO instant; a zero/invalid window has no busy.
  const timeMin = new Date(startISO);
  const timeMax = new Date(endISO);
  if (Number.isNaN(timeMin.getTime()) || Number.isNaN(timeMax.getTime()) || timeMax <= timeMin) {
    return [];
  }

  const accessToken = await getValidAccessToken(cred);
  // Use events.list (calendar.events scope) rather than freeBusy.query (which
  // needs the calendar.freebusy scope). Busy = non-cancelled, non-transparent
  // events overlapping the window.
  const resp = await withGoogleRetry(() =>
    axios.get(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cred.calendarId)}/events`,
      {
        params: {
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 2500,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000,
      }
    )
  );
  const items: Array<{
    status?: string;
    transparency?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
  }> = resp.data?.items || [];
  return items
    .filter((e) => e.status !== 'cancelled' && e.transparency !== 'transparent' && (e.start?.dateTime || e.start?.date))
    .map((e) => ({
      start: new Date(e.start!.dateTime || e.start!.date!),
      end: new Date(e.end?.dateTime || e.end?.date || e.start!.dateTime || e.start!.date!),
    }));
}

export interface CalendarEventInput {
  startISO: string;
  endISO: string;
  timezone: string;
  summary: string;
  description?: string;
}

export interface CalendarEventResult {
  eventId: string;
  meetUrl: string | null;
  calendarId: string;
}

/** Options for create: a deterministic id (idempotent retries) and/or an explicit
 *  target calendar (defaults to the credential's current calendarId). */
export interface CreateEventOpts {
  eventId?: string;
  calendarId?: string;
}

/**
 * Create an owner-only event (no customer attendee → Google sends no invite; we
 * email our own ICS) with a Meet link. Returns null if the bot has no Google
 * connection. Throws on API error so the caller can decide (best-effort sync).
 *
 * When `opts.eventId` is given it becomes the Google event id, making the create
 * idempotent: a retry after a partial failure hits 409 ("already exists"), which
 * we treat as success by fetching the existing event. The id must be valid Google
 * base32hex (callers pass a booking uuid with hyphens stripped).
 */
export async function createCalendarEvent(
  botId: string,
  input: CalendarEventInput,
  opts: CreateEventOpts = {}
): Promise<CalendarEventResult | null> {
  const cred = await getActiveCredential(botId);
  if (!cred) return null;
  const targetCalendarId = opts.calendarId || cred.calendarId;
  const accessToken = await getValidAccessToken(cred);
  const eventsUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events`;
  try {
    const resp = await withGoogleRetry(() =>
      axios.post(
        eventsUrl,
        {
          ...(opts.eventId ? { id: opts.eventId } : {}),
          summary: input.summary,
          description: input.description,
          start: { dateTime: input.startISO, timeZone: input.timezone },
          end: { dateTime: input.endISO, timeZone: input.timezone },
          conferenceData: {
            createRequest: {
              requestId: `axentrio-${opts.eventId ?? `${Date.now()}-${input.startISO.length}`}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        },
        {
          params: { conferenceDataVersion: 1 },
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      )
    );
    return {
      eventId: resp.data.id,
      meetUrl: resp.data.hangoutLink || resp.data.conferenceData?.entryPoints?.[0]?.uri || null,
      calendarId: targetCalendarId,
    };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    // Idempotent retry: the deterministic id already exists → fetch and return it.
    if (status === 409 && opts.eventId) {
      const existingId = opts.eventId;
      const got = await withGoogleRetry(() =>
        axios.get(`${eventsUrl}/${encodeURIComponent(existingId)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000,
        })
      );
      return {
        eventId: got.data.id,
        meetUrl: got.data.hangoutLink || got.data.conferenceData?.entryPoints?.[0]?.uri || null,
        calendarId: targetCalendarId,
      };
    }
    throw err;
  }
}

/**
 * Update an existing event's times. Returns 'not_found' on 404/410 so the caller
 * can recreate, 'no_access' on 403 (e.g. event lives on a now-disconnected
 * account). `calendarId` targets the event's real home (BookingReference.
 * externalCalendarId), defaulting to the credential's current calendar.
 */
export async function updateCalendarEvent(
  botId: string,
  eventId: string,
  input: Pick<CalendarEventInput, 'startISO' | 'endISO' | 'timezone'>,
  calendarId?: string
): Promise<'ok' | 'not_found' | 'no_access' | 'no_connection'> {
  const cred = await getActiveCredential(botId);
  if (!cred) return 'no_connection';
  const target = calendarId || cred.calendarId;
  const accessToken = await getValidAccessToken(cred);
  try {
    await withGoogleRetry(() =>
      axios.patch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(target)}/events/${encodeURIComponent(eventId)}`,
        {
          start: { dateTime: input.startISO, timeZone: input.timezone },
          end: { dateTime: input.endISO, timeZone: input.timezone },
        },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 10000 }
      )
    );
    return 'ok';
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 410) return 'not_found';
    if (status === 403) return 'no_access';
    throw err;
  }
}

/** Delete an event on its home calendar. Swallows 404/410 (already gone); returns
 *  'no_access' on 403 so the caller can mark terminal. */
export async function deleteCalendarEvent(
  botId: string,
  eventId: string,
  calendarId?: string
): Promise<'ok' | 'no_access' | 'no_connection'> {
  const cred = await getActiveCredential(botId);
  if (!cred) return 'no_connection';
  const target = calendarId || cred.calendarId;
  const accessToken = await getValidAccessToken(cred);
  try {
    await withGoogleRetry(() =>
      axios.delete(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(target)}/events/${encodeURIComponent(eventId)}`,
        { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
      )
    );
    return 'ok';
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 403) return 'no_access';
    if (status !== 404 && status !== 410) throw err;
    return 'ok';
  }
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

  // No active calendar anymore → fall back to the bot-scoped conflict key.
  await rekeyBotBookings(botId, conflictKeyFor(botId, null)).catch((err) =>
    logger.warn('[Google] post-disconnect rekey failed (non-fatal)', {
      botId,
      error: err instanceof Error ? err.message : String(err),
    })
  );
}
