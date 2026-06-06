import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface ChannelConnection {
  id: string;
  tenantId: string;
  /** Bot this channel routes to; null = the tenant's default/anchor bot. */
  botId: string | null;
  channel: 'widget' | 'telegram' | 'messenger' | 'instagram' | 'whatsapp';
  status: 'active' | 'disconnected' | 'error' | 'pending_setup';
  label: string | null;
  platformAccountId: string | null;
  config: Record<string, Any>;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type { ChannelConnection };

export function useChannelConnections() {
  return useQuery({
    queryKey: ['channels', 'connections'],
    queryFn: async () => {
      const res = await api.get<Any>('/channels/connections');
      // api.get already unwraps { success, data } envelope via interceptor
      const data = res?.connections ?? res?.data?.connections ?? res;
      return Array.isArray(data) ? data as ChannelConnection[] : [];
    },
  });
}

export function useConnectTelegram() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { botToken: string; label?: string }) => {
      return api.post('/channels/telegram/connect', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Telegram bot connected');
    },
    onError: (error: Any) => {
      toast.error(extractApiErrorMessage(error) ?? 'Failed to connect Telegram bot');
    },
  });
}

export function useConnectWhatsApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      phoneNumberId: string;
      accessToken: string;
      wabaId?: string;
      label?: string;
    }) => {
      return api.post('/channels/whatsapp/connect', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('WhatsApp number connected');
    },
    onError: (error: Any) => {
      toast.error(extractApiErrorMessage(error) ?? 'Failed to connect WhatsApp');
    },
  });
}

export function useMetaOAuthUrl() {
  return useMutation({
    mutationFn: async () => {
      const res = await api.get<Any>('/channels/meta/oauth/url');
      return (res?.url ?? res?.data?.url ?? res) as string;
    },
  });
}

export function useMetaOAuthPages(sessionToken: string | null) {
  return useQuery({
    queryKey: ['channels', 'meta', 'pages', sessionToken],
    queryFn: async () => {
      const res = await api.get<Any>(`/channels/meta/oauth/pages?session=${sessionToken}`);
      return res?.pages ?? res?.data?.pages ?? res;
    },
    enabled: !!sessionToken,
  });
}

export function useConnectMeta() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { pageIds: string[]; sessionToken: string }) => {
      return api.post('/channels/meta/oauth/connect', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Facebook pages connected');
    },
    onError: (error: Any) => {
      toast.error(extractApiErrorMessage(error) ?? 'Failed to connect');
    },
  });
}

export function useDisconnectChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      await api.delete(`/channels/${connectionId}/disconnect`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Channel disconnected');
    },
    onError: (error: Any) => {
      toast.error(extractApiErrorMessage(error) ?? 'Failed to disconnect');
    },
  });
}

export function useUpdateChannelBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ connectionId, botId }: { connectionId: string; botId: string | null }) => {
      return api.patch(`/channels/${connectionId}/bot`, { botId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Channel bot updated');
    },
    onError: (error: Any) => {
      toast.error(extractApiErrorMessage(error) ?? 'Failed to update channel bot');
    },
  });
}

export function useHealthCheckChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      return api.post<Any>(`/channels/${connectionId}/health-check`);
    },
    onSuccess: (res: Any) => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      const conn = res?.data ?? res;
      if (conn?.status === 'active') {
        toast.success('Channel is healthy');
      } else if (conn?.lastError) {
        toast.error(`Health check failed: ${conn.lastError}`);
      } else {
        toast.success('Health check complete');
      }
    },
    onError: (error: Any) => {
      toast.error(extractApiErrorMessage(error) ?? 'Failed to run health check');
    },
  });
}
