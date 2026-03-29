import { useCallback } from 'react';
import { Check } from 'lucide-react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { DialogTitle } from '@/components/ui/dialog';
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

  const handleSelect = useCallback(
    (tenantId: string, tenantName: string, status?: string) => {
      // Don't allow selecting suspended/cancelled tenants
      if (status === 'suspended' || status === 'cancelled') return;
      // Selecting the already-active tenant is a no-op
      if (activeTenant?.tenantId === tenantId) {
        closeTenantPalette();
        return;
      }
      // Switch directly
      switchTenant({ tenantId, tenantName });
    },
    [activeTenant, closeTenantPalette, switchTenant]
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeTenantPalette();
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
      <VisuallyHidden>
        <DialogTitle>Switch tenant</DialogTitle>
      </VisuallyHidden>
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
    </CommandDialog>
  );
}
