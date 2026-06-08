/**
 * Microsoft Graph calendar event CRUD + free/busy (P6c).
 *
 * Mirrors the Google event service through the same botId-keyed contract so the
 * CalendarProvider port can treat them uniformly. Owner-only events (no customer
 * attendee — we email our own ICS) on the account's DEFAULT calendar (`/me`).
 *
 * Time handling (locked UTC fallback, resolves the IANA-coverage gap): every
 * start/end is sent as a UTC instant with `timeZone:"UTC"`, and free/busy is
 * read under `Prefer: outlook.timezone="UTC"`, so no IANA zone is ever sent to
 * Graph and every business timezone is supported. Outlook converts to the
 * viewer's local zone on display, so the absolute time is preserved.
 *
 * Immutable IDs: every id-addressing call (create response capture + every
 * update/delete) sends `Prefer: IdType="ImmutableId"` so a captured id stays
 * addressable across moves.
 */
import axios from 'axios';
import { logger } from '../../utils/logger';
import { getActiveCredential, getValidAccessTokenMicrosoft } from './outlook-calendar.service';
import type {
  CalendarEventInput,
  CalendarEventResult,
  CreateEventOpts,
  GoogleBusyInterval as BusyInterval,
} from '../../integrations/google/google-calendar.service';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const PREFER_IMMUTABLE_UTC = 'IdType="ImmutableId", outlook.timezone="UTC"';

export type { BusyInterval };

/** Retry transient Graph failures (429 / 5xx) with bounded backoff; rethrow 4xx. */
async function withGraphRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const retryable = status === 429 || (status !== undefined && status >= 500 && status < 600);
      if (!retryable || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, Math.min(2000, 200 * 2 ** attempt)));
      attempt++;
    }
  }
}

/** A UTC instant in the `{ dateTime, timeZone }` shape Graph expects (no 'Z'). */
function utcDateTime(iso: string): { dateTime: string; timeZone: string } {
  return { dateTime: new Date(iso).toISOString().replace('Z', ''), timeZone: 'UTC' };
}

/** Graph's `online meeting` errors mean "this account can't host Teams" — the
 *  ONLY case we retry without the online-meeting fields. Matched on the message
 *  substring, never the bare generic code, so unrelated bad-request errors don't
 *  silently drop the Teams link. */
function isOnlineMeetingUnsupported(err: unknown): boolean {
  const data = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data;
  const msg = (data?.error?.message ?? '').toLowerCase();
  return msg.includes('online meeting');
}

/**
 * Busy intervals from the bot's connected Outlook calendar for [startISO,endISO).
 * Returns null when there's no active Microsoft connection. Throws on API/token
 * failure so callers fail closed. Pages through `@odata.nextLink` (the Prefer
 * header is re-attached per page). Maps `showAs` busy|tentative|oof to busy;
 * `free`/`workingElsewhere` and cancelled events are not busy.
 */
export async function getOutlookBusyForBot(
  botId: string,
  startISO: string,
  endISO: string
): Promise<BusyInterval[] | null> {
  const cred = await getActiveCredential(botId);
  if (!cred) return null;
  const token = await getValidAccessTokenMicrosoft(cred);

  const params = new URLSearchParams({
    startDateTime: new Date(startISO).toISOString(),
    endDateTime: new Date(endISO).toISOString(),
    $select: 'start,end,showAs,isCancelled',
    $top: '100',
  });
  let url: string | null = `${GRAPH}/me/calendarView?${params.toString()}`;
  const headers = { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' };
  const busy: BusyInterval[] = [];
  const BUSY = new Set(['busy', 'tentative', 'oof']);

  while (url) {
    const resp: { data: { value?: GraphEvent[]; '@odata.nextLink'?: string } } = await withGraphRetry(() =>
      axios.get(url as string, { headers, timeout: 12000 })
    );
    for (const ev of resp.data.value ?? []) {
      if (ev.isCancelled) continue;
      if (!BUSY.has((ev.showAs ?? 'busy').toLowerCase())) continue;
      if (!ev.start?.dateTime || !ev.end?.dateTime) continue;
      busy.push({ start: parseGraphUtc(ev.start.dateTime), end: parseGraphUtc(ev.end.dateTime) });
    }
    url = resp.data['@odata.nextLink'] ?? null;
  }
  return busy;
}

interface GraphEvent {
  id?: string;
  isCancelled?: boolean;
  showAs?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  onlineMeeting?: { joinUrl?: string } | null;
}

/** Graph returns UTC wall-times (under the Prefer header) WITHOUT a trailing 'Z'. */
function parseGraphUtc(dateTime: string): Date {
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(dateTime) ? dateTime : `${dateTime}Z`);
}

/**
 * Create an owner-only event with a Teams meeting on the default calendar.
 * `opts.eventId` (the deterministic booking-derived id) is sent as Graph's
 * `transactionId` so a retried create dedupes to the same event rather than
 * duplicating. Returns the IMMUTABLE event id + Teams join URL, or null when
 * there's no connection. On an account that can't host Teams, retries once
 * WITHOUT the online-meeting fields (same transactionId) → `meetUrl: null`.
 */
export async function createOutlookEvent(
  botId: string,
  input: CalendarEventInput,
  opts: CreateEventOpts = {}
): Promise<CalendarEventResult | null> {
  const cred = await getActiveCredential(botId);
  if (!cred) return null;
  const token = await getValidAccessTokenMicrosoft(cred);

  const base = {
    subject: input.summary,
    body: { contentType: 'text', content: input.description ?? '' },
    start: utcDateTime(input.startISO),
    end: utcDateTime(input.endISO),
    ...(opts.eventId ? { transactionId: opts.eventId } : {}),
  };
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Prefer: PREFER_IMMUTABLE_UTC,
  };

  const post = (withTeams: boolean) =>
    withGraphRetry(() =>
      axios.post(
        `${GRAPH}/me/events`,
        withTeams ? { ...base, isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : base,
        { headers, timeout: 12000 }
      )
    );

  let resp;
  try {
    resp = await post(true);
  } catch (err) {
    if (!isOnlineMeetingUnsupported(err)) throw err;
    logger.info('[Outlook] account cannot host Teams; creating event without online meeting', { botId });
    resp = await post(false);
  }
  const data = resp.data as GraphEvent;
  return {
    eventId: data.id as string,
    meetUrl: data.onlineMeeting?.joinUrl ?? null,
    calendarId: cred.calendarId,
  };
}

/** Patch an event's times. Returns 'not_found' (404), 'no_access' (403),
 *  'no_connection' (no cred), else 'ok'. Never touches the body. */
export async function updateOutlookEvent(
  botId: string,
  eventId: string,
  input: Pick<CalendarEventInput, 'startISO' | 'endISO' | 'timezone'>
): Promise<'ok' | 'not_found' | 'no_access' | 'no_connection'> {
  const cred = await getActiveCredential(botId);
  if (!cred) return 'no_connection';
  const token = await getValidAccessTokenMicrosoft(cred);
  try {
    await withGraphRetry(() =>
      axios.patch(
        `${GRAPH}/me/events/${encodeURIComponent(eventId)}`,
        { start: utcDateTime(input.startISO), end: utcDateTime(input.endISO) },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Prefer: PREFER_IMMUTABLE_UTC,
          },
          timeout: 12000,
        }
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

/** Delete an event. Swallows 404/410 (already gone). Returns 'no_access' (403),
 *  'no_connection', else 'ok'. */
export async function deleteOutlookEvent(
  botId: string,
  eventId: string
): Promise<'ok' | 'no_access' | 'no_connection'> {
  const cred = await getActiveCredential(botId);
  if (!cred) return 'no_connection';
  const token = await getValidAccessTokenMicrosoft(cred);
  try {
    await withGraphRetry(() =>
      axios.delete(`${GRAPH}/me/events/${encodeURIComponent(eventId)}`, {
        headers: { Authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId"' },
        timeout: 12000,
      })
    );
    return 'ok';
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 410) return 'ok';
    if (status === 403) return 'no_access';
    throw err;
  }
}
