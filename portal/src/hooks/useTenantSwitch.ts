import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useCallback, useMemo } from 'react';
import { useOrganizationList } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { useTenantContextStore } from '../stores/tenantContextStore';
import { useUiStore } from '../stores/uiStore';
import { useSocket } from '../websocket/SocketContext';

/** Query key prefixes that are tenant-scoped and must be flushed on switch */
const TENANT_SCOPED_KEYS = [
  'tenants',
  'dashboard',
  'analytics',
  'chats',
  'handoffs',
  'knowledge',
  'cannedResponses',
  'notifications',
  'webhooks',
  'agents',
];

export function useTenantSwitch() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { setActiveTenant, clearTenant } = useTenantContextStore();
  const { closeTenantPalette } = useUiStore();
  const { reconnect } = useSocket();
  // The user's real Clerk org memberships — used to decide whether a switch is a
  // genuine workspace switch (you belong to it) or a super-admin impersonation view.
  const { userMemberships, setActive } = useOrganizationList({ userMemberships: { infinite: true } });

  const memberOrgIds = useMemo(
    () => new Set((userMemberships?.data ?? []).map((m) => m.organization.id)),
    [userMemberships?.data]
  );

  /** True when the user is a real Clerk member of the given org (→ switch in, not impersonate). */
  const isMemberOrg = useCallback(
    (clerkOrgId?: string | null): boolean => !!clerkOrgId && memberOrgIds.has(clerkOrgId),
    [memberOrgIds]
  );

  const flushAndRedirect = useCallback(
    (path = '/inbox') => {
      // Remove all tenant-scoped caches (not admin caches)
      for (const key of TENANT_SCOPED_KEYS) {
        queryClient.removeQueries({ queryKey: [key] });
      }
      // Reconnect socket so server picks up new tenant context
      reconnect();
      // Redirect (default dashboard) to avoid 404s on tenant-scoped routes
      navigate(path, { replace: true });
    },
    [queryClient, navigate, reconnect]
  );

  // `redirectTo` lets callers (e.g. the guardrails cockpit deep-link) land on a
  // specific tenant-scoped route after switching, instead of the default inbox.
  const switchTenant = useCallback(
    async (
      tenant: { tenantId: string; tenantName: string; clerkOrgId?: string | null },
      redirectTo?: string
    ) => {
      // If the user genuinely belongs to this tenant's Clerk org, switch INTO the
      // workspace (real Clerk active-org switch, sticky across reloads) rather than
      // impersonating it as a super-admin. Drop any impersonation context first so
      // we don't stack an X-Tenant-Context override on top of the switched org.
      if (isMemberOrg(tenant.clerkOrgId) && setActive) {
        clearTenant();
        closeTenantPalette();
        try {
          await setActive({ organization: tenant.clerkOrgId });
        } catch {
          toast.error(`Couldn't switch to ${tenant.tenantName}`);
          return;
        }
        flushAndRedirect(redirectTo);
        toast.success(`Switched to ${tenant.tenantName}`);
        return;
      }

      // Not a member: super-admin impersonation view (X-Tenant-Context header).
      setActiveTenant({ tenantId: tenant.tenantId, tenantName: tenant.tenantName });
      closeTenantPalette();
      flushAndRedirect(redirectTo);
      toast.success(`Now viewing ${tenant.tenantName}`);
    },
    [isMemberOrg, setActive, clearTenant, setActiveTenant, closeTenantPalette, flushAndRedirect]
  );

  const exitTenant = useCallback(() => {
    clearTenant();
    closeTenantPalette();
    flushAndRedirect();
    toast.success('Returned to your own context');
  }, [clearTenant, closeTenantPalette, flushAndRedirect]);

  return { switchTenant, exitTenant, isMemberOrg };
}
