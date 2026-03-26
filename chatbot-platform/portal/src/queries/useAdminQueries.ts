import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const adminOptions = {
  tenants: () => queryOptions({
    queryKey: queryKeys.admin.tenants(),
    queryFn: () => api.get<Any[]>('/admin/tenants'),
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

export function useAdminAuditLogs(params?: Record<string, unknown>) {
  return useQuery({
    queryKey: [...queryKeys.admin.auditLogs(), params],
    queryFn: () => api.get('/admin/audit-logs', { params }),
  });
}

// --- Mutations ---

export function useSuspendTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/tenants/${id}/suspend`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants() });
      toast.success('Tenant suspended');
    },
  });
}

export function useActivateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/tenants/${id}/activate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants() });
      toast.success('Tenant activated');
    },
  });
}

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

export function usePromoteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/promote`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
      toast.success('User promoted to super admin');
    },
  });
}

export function useDemoteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/demote`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
      toast.success('User demoted');
    },
  });
}
