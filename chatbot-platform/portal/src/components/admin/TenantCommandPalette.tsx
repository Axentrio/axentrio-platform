import { useState, useCallback } from 'react';
import { Check } from 'lucide-react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useUiStore } from '../../stores/uiStore';
import { useTenantContextStore } from '../../stores/tenantContextStore';
import { useAdminTenantsAll } from '../../queries/useAdminQueries';
import { useTenantSwitch } from '../../hooks/useTenantSwitch';
import { cn } from '@/lib/utils';

export function TenantCommandPalette() {
  const { isTenantPaletteOpen, closeTenantPalette } = useUiStore();
  const { activeTenant } = useTenantContextStore();
  const { switchTenant } = useTenantSwitch();
  const { data: tenants, isLoading, isError, refetch } = useAdminTenantsAll();

  const [pendingTenant, setPendingTenant] = useState<{
    tenantId: string;
    tenantName: string;
  } | null>(null);

  const handleSelect = useCallback(
    (tenantId: string, tenantName: string, status: string) => {
      // Don't allow selecting suspended/cancelled tenants
      if (status !== 'active') return;
      // Selecting the already-active tenant is a no-op
      if (activeTenant?.tenantId === tenantId) {
        closeTenantPalette();
        return;
      }
      setPendingTenant({ tenantId, tenantName });
    },
    [activeTenant, closeTenantPalette]
  );

  const handleConfirm = useCallback(() => {
    if (pendingTenant) {
      switchTenant(pendingTenant);
      setPendingTenant(null);
    }
  }, [pendingTenant, switchTenant]);

  const handleCancel = useCallback(() => {
    setPendingTenant(null);
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeTenantPalette();
        setPendingTenant(null);
      }
    },
    [closeTenantPalette]
  );

  // Sort: active tenant pinned to top, then alphabetical
  const sortedTenants = tenants
    ? [...tenants].sort((a, b) => {
        if (a.id === activeTenant?.tenantId) return -1;
        if (b.id === activeTenant?.tenantId) return 1;
        return (a.name as string).localeCompare(b.name as string);
      })
    : [];

  return (
    <CommandDialog open={isTenantPaletteOpen} onOpenChange={handleOpenChange}>
      <CommandInput placeholder="Search tenants..." />
      <CommandList>
        {isLoading && (
          <div className="py-6 space-y-2 px-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-8 bg-surface-2 rounded animate-pulse"
              />
            ))}
          </div>
        )}
        {isError && (
          <div className="py-6 text-center">
            <p className="text-sm text-text-muted mb-2">
              Failed to load tenants
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        )}
        {!isLoading && !isError && (
          <>
            <CommandEmpty>No tenants match your search</CommandEmpty>
            <CommandGroup>
              {sortedTenants.map((tenant) => {
                const isActive = activeTenant?.tenantId === tenant.id;
                const isInactive =
                  tenant.status === 'suspended' || tenant.status === 'cancelled';
                return (
                  <CommandItem
                    key={tenant.id}
                    value={tenant.name}
                    onSelect={() =>
                      handleSelect(tenant.id, tenant.name, tenant.status)
                    }
                    disabled={isInactive}
                    className={cn(
                      isInactive && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    <div className="flex items-center justify-between w-full">
                      <div className="flex items-center gap-2 min-w-0">
                        {isActive && (
                          <Check className="w-4 h-4 text-primary-500 flex-shrink-0" />
                        )}
                        <span className="truncate">{tenant.name}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                        {isInactive && (
                          <Badge variant="outline" className="text-xs capitalize">
                            {tenant.status}
                          </Badge>
                        )}
                        <Badge variant="secondary" className="text-xs capitalize">
                          {tenant.tier}
                        </Badge>
                      </div>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>

      {/* Confirmation bar */}
      {pendingTenant && (
        <div className="border-t border-edge px-4 py-3 flex items-center justify-between bg-surface-1">
          <span className="text-sm text-text-secondary">
            Switch to <strong className="text-text-primary">{pendingTenant.tenantName}</strong>?
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleConfirm}>
              Confirm
            </Button>
          </div>
        </div>
      )}
    </CommandDialog>
  );
}
