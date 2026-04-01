import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import apiClient, { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const adminOptions = {
  tenants: () => queryOptions({
    queryKey: queryKeys.admin.tenants(),
    queryFn: async () => {
      const result = await api.get<Any>('/admin/tenants');
      return (Array.isArray(result) ? result : result?.data ?? result) as Any[];
    },
  }),
  tenantDetail: (id: string) => queryOptions({
    queryKey: queryKeys.admin.tenantDetail(id),
    queryFn: () => api.get<Any>(`/admin/tenants/${id}`),
    enabled: !!id,
  }),
  tenantAudit: (id: string) => queryOptions({
    queryKey: queryKeys.admin.tenantAudit(id),
    queryFn: () => api.get<Any>(`/admin/tenants/${id}/audit-logs?limit=20`),
    refetchInterval: 30_000,
    enabled: !!id,
  }),
  users: () => queryOptions({
    queryKey: queryKeys.admin.users(),
    queryFn: () => api.get<Any[]>('/admin/users'),
  }),
  analytics: () => queryOptions({
    queryKey: queryKeys.admin.analytics(),
    queryFn: () => api.get<Any>('/admin/analytics'),
  }),
};

export function useAdminTenants() {
  return useQuery(adminOptions.tenants());
}

export function useAdminTenantsAll() {
  return useQuery({
    queryKey: [...queryKeys.admin.tenants(), 'all'],
    queryFn: async () => {
      const result = await api.get<Any>('/admin/tenants', { params: { limit: 1000 } });
      // Handle both { data, meta } shape and bare array
      return (Array.isArray(result) ? result : result?.data ?? result) as Any[];
    },
  });
}

export function useAdminTenantDetail(id: string) {
  return useQuery(adminOptions.tenantDetail(id));
}

export function useAdminTenantAudit(id: string) {
  return useQuery(adminOptions.tenantAudit(id));
}

export function useAdminUsers() {
  return useQuery(adminOptions.users());
}

export function useAdminAnalytics() {
  return useQuery(adminOptions.analytics());
}

interface AuditLogResponse {
  data: unknown[];
  meta?: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean };
}

export function useAdminAuditLogs(params?: Record<string, unknown>) {
  return useQuery({
    queryKey: [...queryKeys.admin.auditLogs(), params],
    queryFn: async () => {
      const result = await api.get<AuditLogResponse>('/admin/audit-logs', { params });
      // When meta is present, apiClient returns { data, meta }
      if (result && typeof result === 'object' && 'meta' in result) {
        return result as AuditLogResponse;
      }
      // Fallback: no meta (shouldn't happen after apiClient fix)
      return { data: result as unknown as unknown[] };
    },
  });
}

// --- Mutations ---


export function useCreateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; slug: string; tier?: string; ownerEmail: string; ownerName: string }) =>
      api.post('/admin/tenants', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants() });
      toast.success('Tenant created');
    },
  });
}

// --- Optimistic Mutations ---

export function useOptimisticSuspendTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/tenants/${id}/suspend`),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.tenants() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.admin.tenants());
      queryClient.setQueryData<Any[]>(queryKeys.admin.tenants(), (prev = []) =>
        prev.map((t: Any) => (t.id === id ? { ...t, status: 'suspended' } : t)),
      );
      return { previousData };
    },
    onError: (_error, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.admin.tenants(), context.previousData);
      }
      toast.error('Failed to suspend tenant');
    },
    onSuccess: () => toast.success('Tenant suspended'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants() });
    },
  });
}

export function useOptimisticActivateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/tenants/${id}/activate`),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.tenants() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.admin.tenants());
      queryClient.setQueryData<Any[]>(queryKeys.admin.tenants(), (prev = []) =>
        prev.map((t: Any) => (t.id === id ? { ...t, status: 'active' } : t)),
      );
      return { previousData };
    },
    onError: (_error, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.admin.tenants(), context.previousData);
      }
      toast.error('Failed to activate tenant');
    },
    onSuccess: () => toast.success('Tenant activated'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants() });
    },
  });
}

export function useOptimisticPromoteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/promote`),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.users() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.admin.users());
      queryClient.setQueryData<Any[]>(queryKeys.admin.users(), (prev = []) =>
        prev.map((u: Any) => (u.id === id ? { ...u, role: 'super_admin' } : u)),
      );
      return { previousData };
    },
    onError: (_error, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.admin.users(), context.previousData);
      }
      toast.error('Failed to promote user');
    },
    onSuccess: () => toast.success('User promoted to super admin'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
    },
  });
}

export function useOptimisticDemoteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/demote`),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.users() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.admin.users());
      queryClient.setQueryData<Any[]>(queryKeys.admin.users(), (prev = []) =>
        prev.map((u: Any) => (u.id === id ? { ...u, role: 'admin' } : u)),
      );
      return { previousData };
    },
    onError: (_error, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.admin.users(), context.previousData);
      }
      toast.error('Failed to demote user');
    },
    onSuccess: () => toast.success('User demoted'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
    },
  });
}

export function useOptimisticDeactivateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/deactivate`),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.users() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.admin.users());
      queryClient.setQueryData<Any[]>(queryKeys.admin.users(), (prev = []) =>
        prev.map((u: Any) => (u.id === id ? { ...u, isActive: false } : u)),
      );
      return { previousData };
    },
    onError: (_error, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.admin.users(), context.previousData);
      }
      toast.error('Failed to deactivate user');
    },
    onSuccess: () => toast.success('User deactivated'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
    },
  });
}

export function useOptimisticReactivateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/reactivate`),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.users() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.admin.users());
      queryClient.setQueryData<Any[]>(queryKeys.admin.users(), (prev = []) =>
        prev.map((u: Any) => (u.id === id ? { ...u, isActive: true } : u)),
      );
      return { previousData };
    },
    onError: (_error, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.admin.users(), context.previousData);
      }
      toast.error('Failed to reactivate user');
    },
    onSuccess: () => toast.success('User reactivated'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/${id}`),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.users() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.admin.users());
      queryClient.setQueryData<Any[]>(queryKeys.admin.users(), (prev = []) =>
        prev.filter((u: Any) => u.id !== id),
      );
      return { previousData };
    },
    onError: (_error, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.admin.users(), context.previousData);
      }
      toast.error('Failed to delete user');
    },
    onSuccess: () => toast.success('User permanently deleted'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
    },
  });
}

export function useAdminResendInvite(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) =>
      api.post(`/admin/tenants/${tenantId}/pending-invites/${inviteId}/resend`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantDetail(tenantId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantAudit(tenantId) });
      toast.success('Invite resent');
    },
    onError: () => toast.error('Failed to resend invite'),
  });
}

export function useAdminCancelInvite(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) =>
      api.delete(`/admin/tenants/${tenantId}/pending-invites/${inviteId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantDetail(tenantId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantAudit(tenantId) });
      toast.success('Invite cancelled');
    },
    onError: () => toast.error('Failed to cancel invite'),
  });
}

// --- CSV Export ---

export async function downloadAuditLogsCsv(params: Record<string, string>) {
  const response = await apiClient.get('/admin/audit-logs/export', {
    params,
    responseType: 'blob',
  });
  const url = window.URL.createObjectURL(new Blob([response.data as BlobPart]));
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}
