import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const webhookOptions = {
  status: () => queryOptions({
    queryKey: queryKeys.webhooks.status(),
    queryFn: () => api.get<Any>('/tenants/me/webhooks/status'),
    refetchInterval: 30_000,
  }),
  deliveries: (page: number) => queryOptions({
    queryKey: queryKeys.webhooks.deliveries(page),
    queryFn: () => api.get<Any>(`/tenants/me/webhooks/deliveries?page=${page}&limit=20`),
  }),
};

export function useWebhookStatus() {
  return useQuery(webhookOptions.status());
}

export function useWebhookDeliveries(page: number) {
  return useQuery(webhookOptions.deliveries(page));
}

export function useSaveWebhookUrl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (webhookUrl: string) => api.patch('/tenants/me', { webhookUrl }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.status() });
      toast.success('Webhook URL saved');
    },
  });
}

export function useTestWebhook() {
  return useMutation({
    mutationFn: () => api.post('/tenants/me/webhooks/test'),
    onSuccess: () => {
      toast.success('Test webhook sent');
    },
  });
}
