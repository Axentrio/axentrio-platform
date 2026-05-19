import { useState, useCallback, useEffect, useRef } from 'react';
import { Check, Search } from 'lucide-react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useUiStore } from '../../stores/uiStore';
import { useTenantContextStore } from '../../stores/tenantContextStore';
import { useAdminTenantsAll } from '../../queries/useAdminQueries';
import { useTenantSwitch } from '../../hooks/useTenantSwitch';
import { useAppAuth } from '../../auth/useAppAuth';
import { cn } from '@/lib/utils';

export function TenantCommandPalette() {
  const { isTenantPaletteOpen, closeTenantPalette } = useUiStore();
  const { activeTenant } = useTenantContextStore();
  const { tenantId: ownTenantId } = useAppAuth();
  const { switchTenant } = useTenantSwitch();
  // Only fetch when the palette is actually open — saves a 1000-row trip
  // on every page navigation. Cached for 60s, so toggling open/close stays
  // instant after the first open.
  const { data: tenants, isLoading, isError, refetch } = useAdminTenantsAll({
    enabled: isTenantPaletteOpen,
  });
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus search input when opened
  useEffect(() => {
    if (isTenantPaletteOpen) {
      setSearch('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isTenantPaletteOpen]);

  const handleSelect = useCallback(
    (tenantId: string, tenantName: string, status?: string) => {
      if (status === 'suspended' || status === 'cancelled') return;
      const currentId = activeTenant?.tenantId ?? ownTenantId;
      if (currentId === tenantId) {
        closeTenantPalette();
        return;
      }
      switchTenant({ tenantId, tenantName });
    },
    [activeTenant, ownTenantId, closeTenantPalette, switchTenant]
  );

  // Sort: active tenant pinned to top, then alphabetical
  const currentTenantId = activeTenant?.tenantId ?? ownTenantId;
  const sortedTenants = tenants
    ? [...tenants]
        .filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => {
          if (a.id === currentTenantId) return -1;
          if (b.id === currentTenantId) return 1;
          return (a.name as string).localeCompare(b.name as string);
        })
    : [];

  return (
    <Dialog open={isTenantPaletteOpen} onOpenChange={(open) => !open && closeTenantPalette()}>
      <DialogContent className="p-0 gap-0 max-w-md">
        <VisuallyHidden>
          <DialogTitle>Switch tenant</DialogTitle>
        </VisuallyHidden>

        {/* Search input */}
        <div className="flex items-center border-b border-edge px-3">
          <Search className="mr-2 h-4 w-4 shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tenants..."
            className="flex h-11 w-full bg-transparent py-3 text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>

        {/* Tenant list */}
        <div className="max-h-[300px] overflow-y-auto p-1">
          {isLoading && (
            <div className="py-6 space-y-2 px-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-8 bg-surface-2 rounded animate-pulse" />
              ))}
            </div>
          )}

          {isError && (
            <div className="py-6 text-center">
              <p className="text-sm text-text-muted mb-2">Failed to load tenants</p>
              <button
                onClick={() => refetch()}
                className="text-sm text-primary-400 hover:text-primary-300 underline"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoading && !isError && sortedTenants.length === 0 && (
            <div className="py-6 text-center text-sm text-text-muted">
              No tenants match your search
            </div>
          )}

          {!isLoading && !isError && sortedTenants.map((tenant) => {
            const isActive = activeTenant
              ? activeTenant.tenantId === tenant.id
              : ownTenantId === tenant.id;
            const isInactive = tenant.status === 'suspended' || tenant.status === 'cancelled';

            return (
              <button
                key={tenant.id}
                onClick={() => handleSelect(tenant.id, tenant.name, tenant.status)}
                disabled={isInactive}
                className={cn(
                  'w-full flex items-center justify-between rounded-md px-2 py-2 text-sm text-left',
                  'transition-colors duration-100 cursor-pointer',
                  'hover:bg-primary-500/[0.08]',
                  isActive && 'bg-primary-500/[0.05]',
                  isInactive && 'opacity-50 cursor-not-allowed'
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isActive && (
                    <Check className="w-4 h-4 text-primary-500 flex-shrink-0" />
                  )}
                  <span className="truncate">{tenant.name}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                  {isActive && (
                    <Badge variant="success" className="text-xs">
                      Active
                    </Badge>
                  )}
                  {isInactive && (
                    <Badge variant="outline" className="text-xs capitalize">
                      {tenant.status}
                    </Badge>
                  )}
                  <Badge variant="secondary" className="text-xs capitalize">
                    {tenant.tier}
                  </Badge>
                </div>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
