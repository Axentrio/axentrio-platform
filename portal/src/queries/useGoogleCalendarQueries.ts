import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface GoogleCalendarStatus {
  connected: boolean;
  accountEmail: string | null;
  calendarId: string | null;
}

const statusKey = ['google', 'status'] as const;

export function useGoogleCalendarStatus() {
  return useQuery({
    queryKey: statusKey,
    queryFn: async () => (await api.get<Any>('/integrations/google/status')) as GoogleCalendarStatus,
  });
}

/** Fetches the consent URL and redirects the browser to Google. */
export function useConnectGoogleCalendar() {
  return useMutation({
    mutationFn: async () => {
      const { url } = (await api.get<{ url: string }>('/integrations/google/connect-url')) as { url: string };
      window.location.href = url;
    },
    onError: (err: Any) => {
      toast.error(
        extractApiErrorMessage(err) ?? (err instanceof Error ? err.message : undefined) ?? 'Failed to start Google connect'
      );
    },
  });
}

export function useDisconnectGoogleCalendar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete('/integrations/google/disconnect'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: statusKey });
      toast.success('Google Calendar disconnected');
    },
    onError: (err: Any) => {
      toast.error(extractApiErrorMessage(err) ?? 'Failed to disconnect');
    },
  });
}
