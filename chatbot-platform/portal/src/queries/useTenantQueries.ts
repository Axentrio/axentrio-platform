import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const tenantOptions = {
  me: () => queryOptions({
    queryKey: queryKeys.tenants.me(),
    queryFn: () => api.get<Any>('/tenants/me'),
  }),
  members: () => queryOptions({
    queryKey: queryKeys.tenants.members(),
    queryFn: () => api.get<Any[]>('/tenants/me/users'),
  }),
  invites: () => queryOptions({
    queryKey: queryKeys.tenants.invites(),
    queryFn: () => api.get<Any[]>('/tenants/me/pending-invites'),
  }),
};

export function useTenantSettings() {
  return useQuery(tenantOptions.me());
}

export function useTenantMembers() {
  return useQuery(tenantOptions.members());
}

export function useTenantInvites() {
  return useQuery(tenantOptions.invites());
}

export function useUpdateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => api.patch('/tenants/me', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      toast.success('Settings saved');
    },
  });
}

export function useRotateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/tenants/me/api-key/rotate'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      toast.success('API key rotated');
    },
  });
}

export function useInviteMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { email: string; name: string; role: string }) =>
      api.post('/tenants/me/invite', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.invites() });
      toast.success('Invitation sent');
    },
  });
}

export function useResendInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => api.post(`/tenants/me/pending-invites/${inviteId}/resend`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.invites() });
      toast.success('Invitation resent');
    },
  });
}

export function useCancelInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => api.delete(`/tenants/me/pending-invites/${inviteId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.invites() });
      toast.success('Invitation cancelled');
    },
  });
}

export function useUpdateMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api.patch(`/tenants/me/users/${userId}`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
      toast.success('Role updated');
    },
  });
}

export function useDeactivateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.post(`/tenants/me/users/${userId}/deactivate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
      toast.success('Member deactivated');
    },
  });
}

export function useReactivateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.post(`/tenants/me/users/${userId}/reactivate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
      toast.success('Member reactivated');
    },
  });
}
