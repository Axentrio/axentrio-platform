import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { toast } from 'sonner';
import { agentSegment, withAgent } from './agentScope';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface OutlookCalendarStatus {
  connected: boolean;
  accountEmail: string | null;
  calendarId: string | null;
  /**
   * The API has always returned this; the type dropped it, so an expired Outlook token
   * rendered as a healthy green "Connected" while bookings silently degraded to
   * request-only. Google has had a reconnect banner all along.
   */
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
const statusKey = (agentId?: string) => ['outlook', 'status', agentSegment(agentId)] as const;

export function useOutlookCalendarStatus(agentId?: string) {
  return useQuery({
    queryKey: statusKey(agentId),
    queryFn: async () => (await api.get<Any>(withAgent('/integrations/outlook/status', agentId))) as OutlookCalendarStatus,
  });
}

/** Fetches the consent URL and redirects the browser to Microsoft. */
export function useConnectOutlookCalendar(agentId?: string) {
  return useMutation({
    mutationFn: async () => {
      const { url } = (await api.get<{ url: string }>(withAgent('/integrations/outlook/connect-url', agentId))) as { url: string };
      window.location.href = url;
    },
    onError: (err: Any) => {
      toast.error(
        extractApiErrorMessage(err) ?? (err instanceof Error ? err.message : undefined) ?? 'Failed to start Outlook connect'
      );
    },
  });
}

export function useDisconnectOutlookCalendar(agentId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(withAgent('/integrations/outlook/disconnect', agentId)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: statusKey(agentId) });
      toast.success('Outlook Calendar disconnected');
    },
    onError: (err: Any) => {
      toast.error(extractApiErrorMessage(err) ?? 'Failed to disconnect');
    },
  });
}
