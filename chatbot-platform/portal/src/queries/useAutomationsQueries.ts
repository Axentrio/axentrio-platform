import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface AutomationsResponse {
  automations: Record<string, Any>;
}

export function useGetAutomations() {
  return useQuery({
    queryKey: queryKeys.automations.config(),
    queryFn: () => api.get<AutomationsResponse>('/tenants/me/automations'),
  });
}

export function useUpdateAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ type, data }: { type: string; data: Any }) =>
      api.patch(`/tenants/me/automations/email/${type}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.automations.config() });
      toast.success('Automation updated');
    },
    onError: (err: Any) => {
      const msg =
        extractApiErrorMessage(err) ??
        (err instanceof Error ? err.message : undefined) ??
        'Failed to update automation';
      toast.error(msg);
    },
  });
}

export function useTestAutomation() {
  return useMutation({
    mutationFn: ({ type, data }: { type: string; data?: Any }) =>
      api.post(`/tenants/me/automations/email/${type}/test`, data),
    onSuccess: () => {
      toast.success('Test sent successfully');
    },
    onError: (err: Any) => {
      const msg =
        extractApiErrorMessage(err) ??
        (err instanceof Error ? err.message : undefined) ??
        'Failed to send test';
      toast.error(msg);
    },
  });
}
