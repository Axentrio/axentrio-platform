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
  UpdateEventResult,
  GoogleBusyInterval as BusyInterval,
} from '../../integrations/google/google-calendar.service';
import type { ExternalEventState, ExternalChangeBatch } from '../../scheduler/calendar-provider';

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

/** Compact Graph error shape for logs: HTTP status, Graph error code, and message. Turns a
 *  swallowed online-meeting failure into something diagnosable instead of a bare log line. */
function graphErrorInfo(err: unknown): { status?: number; code?: string; message?: string } {
  const resp = (err as {
    response?: { status?: number; data?: { error?: { code?: string; message?: string } } };
  })?.response;
  return { status: resp?.status, code: resp?.data?.error?.code, message: resp?.data?.error?.message };
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
  isAllDay?: boolean;
  showAs?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  onlineMeeting?: { joinUrl?: string } | null;
}

/** Graph returns UTC wall-times (under the Prefer header) WITHOUT a trailing 'Z'. */
function parseGraphUtc(dateTime: string): Date {
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(dateTime) ? dateTime : `${dateTime}Z`);
}

/** Graph often returns the event before `onlineMeeting.joinUrl` is set. */
async function readOutlookJoinUrl(token: string, eventId: string): Promise<string | null> {
  const { data } = await withGraphRetry(() =>
    axios.get<GraphEvent>(
      `${GRAPH}/me/events/${encodeURIComponent(eventId)}?$select=id,isOnlineMeeting,onlineMeeting`,
      {
        headers: { Authorization: `Bearer ${token}`, Prefer: PREFER_IMMUTABLE_UTC },
        timeout: 12000,
      },
    ),
  );
  return data.onlineMeeting?.joinUrl ?? null;
}

/**
 * Create an owner-only event with a Teams meeting on the default calendar.
 * `opts.eventId` (the deterministic booking-derived id) is sent as Graph's
 * `transactionId` so a retried create dedupes to the same event rather than
 * duplicating. Returns the IMMUTABLE event id + Teams join URL, or null when
 * there's no connection. On an account that can't host Teams, retries once
 * WITHOUT the online-meeting fields (same transactionId) → `meetUrl: null`.
 * When Graph creates the meeting but omits `joinUrl` on the POST body, GET
 * the event once so the customer invite still carries the Teams link.
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
    // Graph accepts a structured address too, but the venue arrives already flattened and
    // displayName is what Outlook actually shows.
    ...(input.location ? { location: { displayName: input.location } } : {}),
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

  const wantTeams = input.conferencing === true;
  let postedWithTeams = wantTeams;
  let resp;
  try {
    resp = await post(wantTeams);
  } catch (err) {
    if (!isOnlineMeetingUnsupported(err)) throw err;
    // The account rejected the Teams meeting. This is commonly a PERSONAL Microsoft account
    // (which cannot host Teams for Business), or a work account with no Teams licence or a
    // policy that blocks it. The event is still saved so the booking stands, but WITHOUT a
    // join link. Log the real Graph reason at warn so the cause is visible, rather than
    // dropping the meeting silently.
    logger.warn('[Outlook] Teams meeting not created; event saved without a join link', {
      botId,
      ...graphErrorInfo(err),
    });
    postedWithTeams = false;
    resp = await post(false);
  }
  const data = resp.data as GraphEvent;
  let meetUrl = data.onlineMeeting?.joinUrl ?? null;
  if (postedWithTeams && !meetUrl && data.id) {
    try {
      meetUrl = await readOutlookJoinUrl(token, data.id);
    } catch (err) {
      logger.warn('[Outlook] Teams join URL GET failed; event stands without meetUrl', {
        botId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    eventId: data.id as string,
    meetUrl,
    calendarId: cred.calendarId,
  };
}

/** Patch an event's times. When `location` or `conferencing` is present, those
 *  fields are rewritten too. Never touches the body. */
export async function updateOutlookEvent(
  botId: string,
  eventId: string,
  input: Pick<CalendarEventInput, 'startISO' | 'endISO' | 'timezone'> &
    Partial<Pick<CalendarEventInput, 'location' | 'conferencing'>>
): Promise<UpdateEventResult> {
  const cred = await getActiveCredential(botId);
  if (!cred) return { status: 'no_connection' };
  const token = await getValidAccessTokenMicrosoft(cred);
  const times = {
    start: utcDateTime(input.startISO),
    end: utcDateTime(input.endISO),
  };
  const base: Record<string, unknown> = { ...times };
  if (input.location !== undefined) base.location = { displayName: input.location };
  if (input.conferencing === false) base.isOnlineMeeting = false;

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Prefer: PREFER_IMMUTABLE_UTC,
  };
  const patch = (body: Record<string, unknown>) =>
    withGraphRetry(() =>
      axios.patch(`${GRAPH}/me/events/${encodeURIComponent(eventId)}`, body, {
        headers,
        timeout: 12000,
      }),
    );

  try {
    let data: GraphEvent;
    if (input.conferencing === true) {
      try {
        const resp = await patch({
          ...base,
          isOnlineMeeting: true,
          onlineMeetingProvider: 'teamsForBusiness',
        });
        data = resp.data as GraphEvent;
      } catch (err) {
        if (!isOnlineMeetingUnsupported(err)) throw err;
        logger.warn('[Outlook] Teams meeting not added on update; event saved without a join link', {
          botId,
          ...graphErrorInfo(err),
        });
        const resp = await patch(base);
        data = resp.data as GraphEvent;
        return { status: 'ok', meetUrl: null };
      }
      let meetUrl = data.onlineMeeting?.joinUrl ?? null;
      if (!meetUrl && data.id) {
        meetUrl = await readOutlookJoinUrl(token, data.id);
      }
      return { status: 'ok', meetUrl };
    }
    await patch(base);
    return { status: 'ok', meetUrl: null };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 410) return { status: 'not_found' };
    if (status === 403) return { status: 'no_access' };
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

export async function getOutlookEvent(botId: string, eventId: string): Promise<ExternalEventState> {
  const cred = await getActiveCredential(botId);
  if (!cred) return { kind: 'no_connection' };
  const token = await getValidAccessTokenMicrosoft(cred);
  try {
    const { data } = await withGraphRetry(() =>
      axios.get<GraphEvent>(`${GRAPH}/me/events/${encodeURIComponent(eventId)}`, {
        headers: { Authorization: `Bearer ${token}`, Prefer: PREFER_IMMUTABLE_UTC },
        timeout: 12000,
      })
    );
    const allDay = data.isAllDay === true;
    return {
      kind: 'found',
      startISO: allDay || !data.start?.dateTime ? null : parseGraphUtc(data.start.dateTime).toISOString(),
      endISO: allDay || !data.end?.dateTime ? null : parseGraphUtc(data.end.dateTime).toISOString(),
      cancelled: data.isCancelled === true,
    };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 410) return { kind: 'not_found' };
    if (status === 403) return { kind: 'no_access' };
    throw err;
  }
}

interface GraphDeltaPage {
  value?: Array<{ id?: string }>;
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

async function followOutlookDelta(
  token: string,
  url: string
): Promise<{ eventIds: string[]; cursor: string }> {
  const eventIds: string[] = [];
  let next: string | undefined = url;
  let deltaLink: string | undefined;
  while (next) {
    const current: string = next;
    const resp = await withGraphRetry(() =>
      axios.get<GraphDeltaPage>(current, {
        headers: { Authorization: `Bearer ${token}`, Prefer: PREFER_IMMUTABLE_UTC },
        timeout: 12000,
      })
    );
    const data: GraphDeltaPage = resp.data;
    for (const item of data.value ?? []) {
      if (item.id) eventIds.push(item.id);
    }
    next = data['@odata.nextLink'];
    deltaLink = data['@odata.deltaLink'] ?? deltaLink;
  }
  if (!deltaLink) {
    throw new Error('Outlook calendar sync returned no deltaLink');
  }
  return { eventIds, cursor: deltaLink };
}

export async function listChangedOutlookEvents(
  botId: string,
  cursor: string | null,
  window: { startISO: string; endISO: string }
): Promise<ExternalChangeBatch | null> {
  const cred = await getActiveCredential(botId);
  if (!cred) return null;
  const token = await getValidAccessTokenMicrosoft(cred);
  const bootstrapUrl =
    `${GRAPH}/me/calendarView/delta` +
    `?startDateTime=${encodeURIComponent(window.startISO)}` +
    `&endDateTime=${encodeURIComponent(window.endISO)}`;

  const bootstrap = async (): Promise<ExternalChangeBatch> => {
    const page = await followOutlookDelta(token, bootstrapUrl);
    return { eventIds: [], cursor: page.cursor, bootstrapped: true };
  };

  if (!cursor) return bootstrap();

  try {
    const page = await followOutlookDelta(token, cursor);
    return { eventIds: page.eventIds, cursor: page.cursor, bootstrapped: false };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    const code = (err as { response?: { data?: { error?: { code?: string } } } })?.response?.data?.error?.code;
    if (status !== 410 && code !== 'syncStateNotFound') throw err;
    return bootstrap();
  }
}
