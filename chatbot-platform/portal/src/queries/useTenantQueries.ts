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
    queryFn: async () => {
      const res = await api.get<Any>('/tenants/me/users');
      return Array.isArray(res) ? res : res?.data ?? [];
    },
  }),
  invites: () => queryOptions({
    queryKey: queryKeys.tenants.invites(),
    queryFn: async () => {
      const res = await api.get<Any>('/tenants/me/pending-invites');
      return Array.isArray(res) ? res : res?.data ?? [];
    },
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

// --- Optimistic Mutations ---

export function useOptimisticUpdateMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api.patch(`/tenants/me/users/${userId}`, { role }),
    onMutate: async ({ userId, role }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tenants.members() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.tenants.members());
      queryClient.setQueryData<Any[]>(queryKeys.tenants.members(), (prev = []) =>
        prev.map((m: Any) => (m.id === userId ? { ...m, role } : m)),
      );
      return { previousData };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.tenants.members(), context.previousData);
      }
      toast.error('Failed to update role');
    },
    onSuccess: () => toast.success('Role updated'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
    },
  });
}

export function useOptimisticDeactivateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.post(`/tenants/me/users/${userId}/deactivate`),
    onMutate: async (userId: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tenants.members() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.tenants.members());
      queryClient.setQueryData<Any[]>(queryKeys.tenants.members(), (prev = []) =>
        prev.map((m: Any) => (m.id === userId ? { ...m, isActive: false } : m)),
      );
      return { previousData };
    },
    onError: (_error, _userId, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.tenants.members(), context.previousData);
      }
      toast.error('Failed to deactivate member');
    },
    onSuccess: () => toast.success('Member deactivated'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
    },
  });
}

export function useOptimisticReactivateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.post(`/tenants/me/users/${userId}/reactivate`),
    onMutate: async (userId: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tenants.members() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.tenants.members());
      queryClient.setQueryData<Any[]>(queryKeys.tenants.members(), (prev = []) =>
        prev.map((m: Any) => (m.id === userId ? { ...m, isActive: true } : m)),
      );
      return { previousData };
    },
    onError: (_error, _userId, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.tenants.members(), context.previousData);
      }
      toast.error('Failed to reactivate member');
    },
    onSuccess: () => toast.success('Member reactivated'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
    },
  });
}
