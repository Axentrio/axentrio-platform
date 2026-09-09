import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { toast } from 'sonner';
import { botSegment, withBot } from './botScope';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface GoogleCalendarStatus {
  connected: boolean;
  accountEmail: string | null;
  calendarId: string | null;
  /** True when the stored token can no longer refresh (revoked / expired) and the
   *  owner must reconnect — otherwise availability silently fails closed. */
  needsReauth?: boolean;
}

/**
 * KEYED BY AGENT, and this is the half that makes the scoping real.
 *
 * The endpoints take an Agent since #86, but a tenant-global cache key would hand Agent B the
 * connection status cached for Agent A — so the screen would show A's account under B's name,
 * and the Disconnect button beside it would look like it belonged to B. Scoping the request
 * without the key is worse than scoping neither.
 */
const statusKey = (botId?: string) => ['google', 'status', botSegment(botId)] as const;

/**
 * One writable calendar the owner may send bookings to.
 *
 * `id` is Google's calendar id; `primary` marks the account's own calendar, which the server
 * canonicalises to the literal `'primary'` on write so the stored value never carries the
 * account's email (that would bypass the verified-id_token identity rule).
 */
export interface GoogleCalendarOption {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

/** Keyed by Agent for the same reason the status key is: these calendars belong to the
 *  Agent's connected account, so a tenant-global key would show one Agent's calendars under
 *  another Agent's name. */
const calendarsKey = (botId?: string) => ['google', 'calendars', botSegment(botId)] as const;

/**
 * The writable calendars behind the picker.
 *
 * `enabled` matters here rather than being left to the caller: this endpoint calls Google, so
 * asking for it on a disconnected Agent spends an external request to be told `[]`.
 */
export function useGoogleCalendars(botId?: string, enabled = true) {
  return useQuery({
    queryKey: calendarsKey(botId),
    enabled,
    queryFn: async () => {
      const { calendars } = (await api.get<{ calendars: GoogleCalendarOption[] }>(
        withBot('/integrations/google/calendars', botId)
      )) as { calendars: GoogleCalendarOption[] };
      return calendars;
    },
  });
}

/**
 * Point this Agent's bookings at a different calendar.
 *
 * The server rekeys active future bookings as part of the write, so the status query is
 * refetched too - otherwise the screen keeps showing the calendar the bookings no longer go to.
 */
export function useSetGoogleCalendar(botId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (calendarId: string) =>
      api.put<{ calendarId: string }>(withBot('/integrations/google/calendar', botId), { calendarId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: statusKey(botId) });
      queryClient.invalidateQueries({ queryKey: calendarsKey(botId) });
      toast.success('Bookings will go to that calendar');
    },
    onError: (err: Any) => {
      toast.error(extractApiErrorMessage(err) ?? 'Failed to change the calendar');
    },
  });
}

export function useGoogleCalendarStatus(botId?: string) {
  return useQuery({
    queryKey: statusKey(botId),
    queryFn: async () => (await api.get<Any>(withBot('/integrations/google/status', botId))) as GoogleCalendarStatus,
  });
}

/** Fetches the consent URL and redirects the browser to Google. */
export function useConnectGoogleCalendar(botId?: string) {
  return useMutation({
    mutationFn: async () => {
      const { url } = (await api.get<{ url: string }>(withBot('/integrations/google/connect-url', botId))) as { url: string };
      window.location.href = url;
    },
    onError: (err: Any) => {
      toast.error(
        extractApiErrorMessage(err) ?? (err instanceof Error ? err.message : undefined) ?? 'Failed to start Google connect'
      );
    },
  });
}

export function useDisconnectGoogleCalendar(botId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(withBot('/integrations/google/disconnect', botId)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: statusKey(botId) });
      toast.success('Google Calendar disconnected');
    },
    onError: (err: Any) => {
      toast.error(extractApiErrorMessage(err) ?? 'Failed to disconnect');
    },
  });
}
