import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const adminOptions = {
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

export type ManualTier = 'free' | 'essential' | 'pro' | 'enterprise';

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
      // Required by the backend when downgrading to Free while a live Stripe
      // subscription exists (the override does not cancel it).
      stripeDisposition?: 'will_cancel' | 'leave_active' | null;
      dispositionReason?: string | null;
    }) =>
      api.post(`/admin/tenants/${input.id}/set-tier`, {
        tier: input.tier,
        currentPeriodEnd: input.currentPeriodEnd ?? null,
        billingEmail: input.billingEmail ?? null,
        stripeDisposition: input.stripeDisposition ?? null,
        dispositionReason: input.dispositionReason ?? null,
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

export function useAdminInviteMember(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { email: string; role: string }) =>
      api.post(`/admin/tenants/${tenantId}/invite`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantDetail(tenantId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantAudit(tenantId) });
      toast.success('Invitation sent');
    },
    onError: () => toast.error('Failed to send invite'),
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


// --- Entitlement controls (feature overrides + bespoke modules) ---

export interface FeatureOverrideEntry {
  value: boolean;
  reason: string;
  setBy: string;
  setAt: string;
}

export interface FeatureMeta {
  label: string;
  group: string;
  requires?: string;
}

export interface TenantOverridesResponse {
  tier: string;
  tierDefaults: Record<string, boolean>;
  overrides: Record<string, FeatureOverrideEntry>;
  taxonomy?: Record<string, FeatureMeta>;
  groups?: Record<string, { label: string; collapsed?: boolean }>;
}

export interface TenantModuleRow {
  id: string;
  displayName: string;
  hasConfigSchema: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
  reason: string | null;
  setBy: string | null;
  updatedAt: string | null;
  active: boolean;
}

export function useTenantOverrides(id: string) {
  return useQuery({
    queryKey: queryKeys.admin.tenantOverrides(id),
    queryFn: () => api.get<TenantOverridesResponse>(`/admin/tenants/${id}/feature-overrides`),
    enabled: !!id,
  });
}

/** Replaces the FULL override map — absent features return to tier default. */
export function useSetTenantOverrides(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (overrides: Record<string, { value: boolean; reason: string }>) =>
      api.put<TenantOverridesResponse>(`/admin/tenants/${id}/feature-overrides`, overrides),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantOverrides(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantAudit(id) });
      toast.success('Feature overrides saved');
    },
    onError: (err: Any) =>
      toast.error(err?.response?.data?.error?.message ?? err?.message ?? 'Failed to save overrides'),
  });
}

export function useTenantModules(id: string) {
  return useQuery({
    queryKey: queryKeys.admin.tenantModules(id),
    queryFn: async () => {
      const res = await api.get<Any>(`/admin/tenants/${id}/modules`);
      return (res?.modules ?? res?.data?.modules ?? []) as TenantModuleRow[];
    },
    enabled: !!id,
  });
}

export function useSetTenantModule(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { moduleId: string; enabled: boolean; reason: string; config?: Record<string, unknown> }) =>
      api.put(`/admin/tenants/${id}/modules/${input.moduleId}`, {
        enabled: input.enabled,
        reason: input.reason,
        ...(input.config !== undefined ? { config: input.config } : {}),
      }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantModules(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantAudit(id) });
      toast.success(`Module ${vars.enabled ? 'enabled' : 'disabled'}`);
    },
    onError: (err: Any) =>
      toast.error(err?.response?.data?.error?.message ?? err?.message ?? 'Failed to update module'),
  });
}

// ── Guardrails cockpit (super-admin) ──────────────────────────────────────────

export function useGuardrailFlagged(filters: { source?: string; tenantId?: string; enforced?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.admin.guardrailFlagged(filters),
    queryFn: async () => {
      const res = await api.get<Any>('/admin/guardrails/flagged', { params: { limit: 100, ...filters } });
      return (res?.events ?? []) as Any[];
    },
  });
}

export function useGuardrailSummary(days = 7) {
  return useQuery({
    queryKey: queryKeys.admin.guardrailSummary(days),
    queryFn: async () => (await api.get<Any>('/admin/guardrails/summary', { params: { days } })) as Any,
  });
}

export function useObservabilityOverview(days = 7) {
  return useQuery({
    queryKey: queryKeys.admin.observability(days),
    queryFn: async () => (await api.get<Any>('/admin/observability/overview', { params: { days } })) as Any,
  });
}

// #9 incident-response: look up a single conversation's enforcement state + journals.
export function useGuardrailConversation(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.admin.guardrailConversation(id ?? ''),
    queryFn: async () => (await api.get<Any>(`/admin/guardrails/conversations/${id}`)) as Any,
    enabled: !!id,
  });
}

// #9 reversible action: super-admin cross-tenant resume-AI (audited).
export function useResumeAiAdmin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/guardrails/conversations/${id}/resume-ai`, {}),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.guardrailConversation(id) });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.admin.all(), 'guardrails'] });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.admin.all(), 'observability'] });
      toast.success('AI re-enabled for this conversation');
    },
    onError: (err: Any) =>
      toast.error(err?.response?.data?.error?.message ?? err?.message ?? 'Failed to re-enable AI'),
  });
}

export function useSetTenantGuardrailEnforce() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { tenantId: string; enforce: boolean }) =>
      api.put(`/admin/tenants/${input.tenantId}/guardrails`, { enforce: input.enforce }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: [...queryKeys.admin.all(), 'guardrails'] });
      // The Rollout Health band's enforceOnTenants is keyed under 'observability'.
      queryClient.invalidateQueries({ queryKey: [...queryKeys.admin.all(), 'observability'] });
      toast.success(`Enforce ${vars.enforce ? 'enabled' : 'disabled'}`);
    },
    onError: (err: Any) =>
      toast.error(err?.response?.data?.error?.message ?? err?.message ?? 'Failed to update enforce'),
  });
}
