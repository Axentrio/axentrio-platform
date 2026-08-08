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
