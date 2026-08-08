import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { toast } from 'sonner';
import { agentSegment, withAgent } from './agentScope';

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
const statusKey = (agentId?: string) => ['google', 'status', agentSegment(agentId)] as const;

export function useGoogleCalendarStatus(agentId?: string) {
  return useQuery({
    queryKey: statusKey(agentId),
    queryFn: async () => (await api.get<Any>(withAgent('/integrations/google/status', agentId))) as GoogleCalendarStatus,
  });
}

/** Fetches the consent URL and redirects the browser to Google. */
export function useConnectGoogleCalendar(agentId?: string) {
  return useMutation({
    mutationFn: async () => {
      const { url } = (await api.get<{ url: string }>(withAgent('/integrations/google/connect-url', agentId))) as { url: string };
      window.location.href = url;
    },
    onError: (err: Any) => {
      toast.error(
        extractApiErrorMessage(err) ?? (err instanceof Error ? err.message : undefined) ?? 'Failed to start Google connect'
      );
    },
  });
}

export function useDisconnectGoogleCalendar(agentId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(withAgent('/integrations/google/disconnect', agentId)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: statusKey(agentId) });
      toast.success('Google Calendar disconnected');
    },
    onError: (err: Any) => {
      toast.error(extractApiErrorMessage(err) ?? 'Failed to disconnect');
    },
  });
}
