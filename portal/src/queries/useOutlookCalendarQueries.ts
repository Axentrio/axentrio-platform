import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface OutlookCalendarStatus {
  connected: boolean;
  accountEmail: string | null;
  calendarId: string | null;
}

const statusKey = ['outlook', 'status'] as const;

export function useOutlookCalendarStatus() {
  return useQuery({
    queryKey: statusKey,
    queryFn: async () => (await api.get<Any>('/integrations/outlook/status')) as OutlookCalendarStatus,
  });
}

/** Fetches the consent URL and redirects the browser to Microsoft. */
export function useConnectOutlookCalendar() {
  return useMutation({
    mutationFn: async () => {
      const { url } = (await api.get<{ url: string }>('/integrations/outlook/connect-url')) as { url: string };
      window.location.href = url;
    },
    onError: (err: Any) => {
      toast.error(
        extractApiErrorMessage(err) ?? (err instanceof Error ? err.message : undefined) ?? 'Failed to start Outlook connect'
      );
    },
  });
}

export function useDisconnectOutlookCalendar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete('/integrations/outlook/disconnect'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: statusKey });
      toast.success('Outlook Calendar disconnected');
    },
    onError: (err: Any) => {
      toast.error(extractApiErrorMessage(err) ?? 'Failed to disconnect');
    },
  });
}
