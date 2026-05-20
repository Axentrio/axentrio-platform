import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface CalcomEventType {
  id: number;
  title: string;
  length: number;
  slug: string;
}

interface CalcomIntegration {
  hasApiKey: boolean;
  eventTypeId?: number;
  collectFields?: string[];
  language?: string;
}

interface IntegrationsData {
  calcom?: CalcomIntegration;
}

export function useIntegrations() {
  return useQuery({
    queryKey: queryKeys.integrations.all(),
    queryFn: async () => {
      // GET /integrations returns raw JSON (not enveloped), so no unwrapping needed
      const result = await api.get<Any>('/tenants/me/integrations');
      return result as IntegrationsData;
    },
  });
}

export function useConnectCalcom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (apiKey: string) =>
      api.post<{ eventTypes: CalcomEventType[] }>('/tenants/me/integrations/calcom/connect', { apiKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
    },
    onError: (err: Any) => {
      const msg =
        extractApiErrorMessage(err) ??
        (err instanceof Error ? err.message : undefined) ??
        'Failed to connect';
      toast.error(msg);
    },
  });
}

export function useFetchCalcomEventTypes() {
  return useMutation({
    mutationFn: () => api.get<Any>('/tenants/me/integrations/calcom/event-types'),
    onError: (err: Any) => {
      const msg =
        extractApiErrorMessage(err) ??
        (err instanceof Error ? err.message : undefined) ??
        'Failed to fetch event types';
      toast.error(msg);
    },
  });
}

export function useUpdateIntegrations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Any) => api.patch('/tenants/me/integrations', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      toast.success('Settings saved');
    },
    onError: () => toast.error('Failed to save settings'),
  });
}
