/**
 * P6c — Microsoft Graph event CRUD + free/busy.
 *
 * Pins: no-connection ⇒ null; calendarView pagination + showAs busy-mapping +
 * cancelled filtering + UTC parse; UTC-instant serialization on create/update;
 * Teams-then-retry-without fallback (only on an "online meeting" error);
 * transactionId idempotency tag; 404/403 status mapping; delete swallows 404.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
import axios from 'axios';

const { getActiveCredential, getValidAccessTokenMicrosoft } = vi.hoisted(() => ({
  getActiveCredential: vi.fn(),
  getValidAccessTokenMicrosoft: vi.fn(),
}));
vi.mock('../../integrations/microsoft/outlook-calendar.service', () => ({
  getActiveCredential,
  getValidAccessTokenMicrosoft,
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  getOutlookBusyForBot,
  createOutlookEvent,
  updateOutlookEvent,
  deleteOutlookEvent,
} from '../../integrations/microsoft/outlook-events.service';

const CRED = { calendarId: 'primary' };

beforeEach(() => {
  vi.clearAllMocks();
  getActiveCredential.mockResolvedValue(CRED);
  getValidAccessTokenMicrosoft.mockResolvedValue('access-token');
});

describe('getOutlookBusyForBot', () => {
  it('returns null when the bot has no active connection', async () => {
    getActiveCredential.mockResolvedValue(null);
    expect(await getOutlookBusyForBot('b1', '2026-06-10T00:00:00Z', '2026-06-11T00:00:00Z')).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('pages through nextLink, maps showAs, drops cancelled/free, parses UTC', async () => {
    (axios.get as any)
      .mockResolvedValueOnce({
        data: {
          value: [
            { showAs: 'busy', isCancelled: false, start: { dateTime: '2026-06-10T09:00:00.0000000' }, end: { dateTime: '2026-06-10T09:30:00.0000000' } },
            { showAs: 'free', isCancelled: false, start: { dateTime: '2026-06-10T10:00:00.0000000' }, end: { dateTime: '2026-06-10T10:30:00.0000000' } },
            { showAs: 'busy', isCancelled: true, start: { dateTime: '2026-06-10T11:00:00.0000000' }, end: { dateTime: '2026-06-10T11:30:00.0000000' } },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?page=2',
        },
      })
      .mockResolvedValueOnce({
        data: {
          value: [
            { showAs: 'tentative', isCancelled: false, start: { dateTime: '2026-06-10T14:00:00.0000000' }, end: { dateTime: '2026-06-10T15:00:00.0000000' } },
          ],
        },
      });

    const busy = await getOutlookBusyForBot('b1', '2026-06-10T00:00:00Z', '2026-06-11T00:00:00Z');
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(busy).toEqual([
      { start: new Date('2026-06-10T09:00:00Z'), end: new Date('2026-06-10T09:30:00Z') },
      { start: new Date('2026-06-10T14:00:00Z'), end: new Date('2026-06-10T15:00:00Z') },
    ]);
    // Prefer UTC header sent.
    expect((axios.get as any).mock.calls[0][1].headers.Prefer).toContain('outlook.timezone="UTC"');
  });
});

describe('createOutlookEvent', () => {
  it('returns null when no connection', async () => {
    getActiveCredential.mockResolvedValue(null);
    expect(await createOutlookEvent('b1', { startISO: 'x', endISO: 'y', timezone: 'UTC', summary: 's' })).toBeNull();
  });

  it('creates with Teams, UTC instants + transactionId, returns immutable id + join url', async () => {
    (axios.post as any).mockResolvedValue({
      data: { id: 'IMMUTABLE_ID', onlineMeeting: { joinUrl: 'https://teams.example/join' } },
    });
    const res = await createOutlookEvent(
      'b1',
      { startISO: '2026-06-10T07:00:00.000Z', endISO: '2026-06-10T07:30:00.000Z', timezone: 'Europe/Brussels', summary: 'Haircut', description: 'body' },
      { eventId: 'booking123' }
    );
    expect(res).toEqual({ eventId: 'IMMUTABLE_ID', meetUrl: 'https://teams.example/join', calendarId: 'primary' });
    const [, body, cfg] = (axios.post as any).mock.calls[0];
    expect(body.isOnlineMeeting).toBe(true);
    expect(body.transactionId).toBe('booking123');
    expect(body.start).toEqual({ dateTime: '2026-06-10T07:00:00.000', timeZone: 'UTC' });
    expect(cfg.headers.Prefer).toContain('IdType="ImmutableId"');
  });

  it('retries without online-meeting fields ONLY on an online-meeting error', async () => {
    (axios.post as any)
      .mockRejectedValueOnce({ response: { status: 400, data: { error: { message: 'Cannot create online meeting for this account' } } } })
      .mockResolvedValueOnce({ data: { id: 'ID2', onlineMeeting: null } });
    const res = await createOutlookEvent('b1', { startISO: '2026-06-10T07:00:00Z', endISO: '2026-06-10T07:30:00Z', timezone: 'UTC', summary: 's' }, { eventId: 'bk' });
    expect(res).toMatchObject({ eventId: 'ID2', meetUrl: null });
    expect((axios.post as any).mock.calls[1][1].isOnlineMeeting).toBeUndefined();
    expect((axios.post as any).mock.calls[1][1].transactionId).toBe('bk'); // same tag → dedupe
  });

  it('does NOT retry (rethrows) on an unrelated bad-request error', async () => {
    (axios.post as any).mockRejectedValue({ response: { status: 400, data: { error: { message: 'Invalid subject length' } } } });
    await expect(createOutlookEvent('b1', { startISO: '2026-06-10T07:00:00Z', endISO: '2026-06-10T07:30:00Z', timezone: 'UTC', summary: 's' })).rejects.toBeTruthy();
    expect((axios.post as any).mock.calls.length).toBe(1);
  });
});

describe('updateOutlookEvent / deleteOutlookEvent', () => {
  it('update maps 404→not_found, 403→no_access, ok otherwise', async () => {
    (axios.patch as any).mockResolvedValueOnce({ data: {} });
    expect(await updateOutlookEvent('b1', 'e1', { startISO: '2026-06-10T07:00:00Z', endISO: '2026-06-10T07:30:00Z', timezone: 'UTC' })).toBe('ok');
    (axios.patch as any).mockRejectedValueOnce({ response: { status: 404 } });
    expect(await updateOutlookEvent('b1', 'e1', { startISO: '2026-06-10T07:00:00Z', endISO: '2026-06-10T07:30:00Z', timezone: 'UTC' })).toBe('not_found');
    (axios.patch as any).mockRejectedValueOnce({ response: { status: 403 } });
    expect(await updateOutlookEvent('b1', 'e1', { startISO: '2026-06-10T07:00:00Z', endISO: '2026-06-10T07:30:00Z', timezone: 'UTC' })).toBe('no_access');
  });

  it('update returns no_connection when no cred', async () => {
    getActiveCredential.mockResolvedValue(null);
    expect(await updateOutlookEvent('b1', 'e1', { startISO: '2026-06-10T07:00:00Z', endISO: '2026-06-10T07:30:00Z', timezone: 'UTC' })).toBe('no_connection');
  });

  it('delete swallows 404 as ok, maps 403→no_access', async () => {
    (axios.delete as any).mockRejectedValueOnce({ response: { status: 404 } });
    expect(await deleteOutlookEvent('b1', 'e1')).toBe('ok');
    (axios.delete as any).mockRejectedValueOnce({ response: { status: 403 } });
    expect(await deleteOutlookEvent('b1', 'e1')).toBe('no_access');
  });
});
