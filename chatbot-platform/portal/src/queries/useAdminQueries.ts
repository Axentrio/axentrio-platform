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
    // Endpoint returns the paginated envelope { data, meta }; the apiClient
    // interceptor preserves that shape when meta is present. Unwrap to an
    // array here so consumers can `.map()` without an extra defensive cast.
    queryFn: async () => {
      const res = await api.get<Any>(`/admin/tenants/${id}/audit-logs?limit=20`);
      return Array.isArray(res) ? res : (res?.data ?? []);
    },
    refetchInterval: 30_000,
    enabled: !!id,
  }),
  users: () => queryOptions({
    queryKey: queryKeys.admin.users(),
    queryFn: async () => {
      const result = await api.get<Any>('/admin/users');
      return (Array.isArray(result) ? result : result?.data ?? result) as Any[];
    },
  }),
  analytics: () => queryOptions({
    queryKey: queryKeys.admin.analytics(),
    queryFn: () => api.get<Any>('/admin/analytics'),
  }),
};

export function useAdminTenants() {
  return useQuery(adminOptions.tenants());
}

/**
 * Lazy variant of the all-tenants list, used by the super-admin command
 * palette and audit-log filter dropdown. Pass `enabled: true` only when the
 * UI that needs it actually mounts/opens — otherwise the 1000-row fetch
 * fires on every page navigation, slowing every super-admin route.
 *
 * Default `enabled` is `false` so consumers must opt in explicitly. Cached
 * for 60s so toggling the palette doesn't re-fetch on every open.
 */
export function useAdminTenantsAll(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...queryKeys.admin.tenants(), 'all'],
    queryFn: async () => {
      const result = await api.get<Any>('/admin/tenants', { params: { limit: 1000 } });
      // Handle both { data, meta } shape and bare array
      return (Array.isArray(result) ? result : result?.data ?? result) as Any[];
    },
    enabled: options.enabled ?? false,
    staleTime: 60 * 1000,
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

export type ManualTier = 'free' | 'pro' | 'premium' | 'enterprise';

/**
 * Super-admin "Set tier (manual)" — handles all four tiers via the unified
 * `POST /admin/tenants/:id/set-tier` endpoint. Invalidates tenant detail,
 * tenants list, and audit log so the badge / activity feed updates without
 * a manual refresh.
 *
 * Backend writes a `tier.manual_override` billing_event + `tenant.tier_manual`
 * audit log row.
 */
export function useSetTenantTier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      tier: ManualTier;
      currentPeriodEnd?: string | null;
      billingEmail?: string | null;
    }) =>
      api.post(`/admin/tenants/${input.id}/set-tier`, {
        tier: input.tier,
        currentPeriodEnd: input.currentPeriodEnd ?? null,
        billingEmail: input.billingEmail ?? null,
      }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantDetail(vars.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants() });
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantAudit(vars.id) });
      const label = vars.tier.charAt(0).toUpperCase() + vars.tier.slice(1);
      toast.success(`Tenant tier set to ${label} (manual)`);
    },
    onError: (err: unknown) => {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: string }).message)
          : 'Failed to set tenant tier';
      toast.error(message);
    },
  });
}

/**
 * @deprecated Use {@link useSetTenantTier} with `tier: 'enterprise'` instead.
 * Kept as a thin wrapper for backwards compatibility — calls the new
 * /set-tier route under the hood.
 */
export function useSetTenantEnterprise() {
  const setTier = useSetTenantTier();
  return {
    ...setTier,
    mutate: (input: {
      id: string;
      currentPeriodEnd?: string | null;
      billingEmail?: string | null;
    }, options?: Parameters<typeof setTier.mutate>[1]) =>
      setTier.mutate({ ...input, tier: 'enterprise' }, options),
    mutateAsync: (input: {
      id: string;
      currentPeriodEnd?: string | null;
      billingEmail?: string | null;
    }) => setTier.mutateAsync({ ...input, tier: 'enterprise' }),
  };
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
