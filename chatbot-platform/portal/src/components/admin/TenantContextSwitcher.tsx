import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTenantContextStore } from '../../stores/tenantContextStore';
import { useAppAuth } from '../../auth/useAppAuth';
import { api } from '../../services/apiClient';

interface TenantListItem {
  id: string;
  name: string;
  tier: string;
  status: string;
}

interface TenantsResponse {
  success: boolean;
  data: TenantListItem[];
}

export function TenantContextSwitcher() {
  const { user } = useAppAuth();
  const { activeTenant, setActiveTenant, clearTenant } = useTenantContextStore();
  const [isOpen, setIsOpen] = useState(false);

  // Only render for super admins
  if (!user || user.role !== 'super_admin') return null;

  const { data: tenants } = useQuery<TenantsResponse>({
    queryKey: ['admin-tenants-switcher'],
    queryFn: () => api.get('/admin/tenants?limit=50'),
    enabled: true,
  });

  if (activeTenant) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 text-amber-400 rounded-lg text-sm border border-amber-500/20">
        <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
        <span>
          Viewing: <strong>{activeTenant.tenantName}</strong>
        </span>
        <button
          onClick={clearTenant}
          className="ml-1 hover:text-amber-300 underline text-xs"
        >
          Exit
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary bg-surface-2 hover:bg-surface-3 rounded-lg border border-edge transition-colors"
      >
        <span className="w-2 h-2 rounded-full bg-primary-500" />
        Switch tenant...
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-surface-0 border border-edge rounded-lg shadow-xl overflow-hidden">
            <div className="max-h-64 overflow-y-auto">
              {tenants?.data?.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setActiveTenant({ tenantId: t.id, tenantName: t.name });
                    setIsOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2 transition-colors flex items-center justify-between"
                >
                  <span className="text-text-primary truncate">{t.name}</span>
                  <span className="text-xs text-text-muted capitalize ml-2">{t.tier}</span>
                </button>
              ))}
              {(!tenants?.data || tenants.data.length === 0) && (
                <div className="px-3 py-4 text-sm text-text-muted text-center">
                  No tenants found
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
