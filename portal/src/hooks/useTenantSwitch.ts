import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useCallback } from 'react';
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
    (tenant: { tenantId: string; tenantName: string }, redirectTo?: string) => {
      setActiveTenant(tenant);
      closeTenantPalette();
      flushAndRedirect(redirectTo);
      toast.success(`Now viewing ${tenant.tenantName}`);
    },
    [setActiveTenant, closeTenantPalette, flushAndRedirect]
  );

  const exitTenant = useCallback(() => {
    clearTenant();
    closeTenantPalette();
    flushAndRedirect();
    toast.success('Returned to your own context');
  }, [clearTenant, closeTenantPalette, flushAndRedirect]);

  return { switchTenant, exitTenant };
}
