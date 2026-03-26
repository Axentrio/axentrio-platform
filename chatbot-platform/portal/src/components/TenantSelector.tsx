/**
 * TenantSelector Component
 * Dropdown for filtering by tenant
 * Uses shadcn Popover + Command (combobox pattern)
 */

import React, { useState } from 'react';
import { ChevronDown, Building2, Check } from 'lucide-react';
import type { Tenant } from '@app-types/index';
import { cn } from '@/lib/utils';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';

interface TenantSelectorProps {
  tenants: Tenant[];
  selectedTenantId?: string;
  onSelect: (tenantId: string | undefined) => void;
  placeholder?: string;
  showAllOption?: boolean;
  className?: string;
  disabled?: boolean;
}

export const TenantSelector: React.FC<TenantSelectorProps> = ({
  tenants,
  selectedTenantId,
  onSelect,
  placeholder = 'Select tenant...',
  showAllOption = true,
  className = '',
  disabled = false,
}) => {
  const [open, setOpen] = useState(false);

  const selectedTenant = tenants.find((t) => t.id === selectedTenantId);

  const handleSelect = (tenantId: string | undefined) => {
    onSelect(tenantId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('w-full justify-between gap-2 text-left text-sm', className)}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Building2 className="w-4 h-4 text-text-muted flex-shrink-0" />
            <span className="truncate">
              {selectedTenant ? selectedTenant.name : placeholder}
            </span>
          </div>
          <ChevronDown
            className={cn(
              'w-4 h-4 text-text-muted flex-shrink-0 transition-transform',
              open && 'rotate-180'
            )}
          />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search tenants..." />
          <CommandList>
            <CommandEmpty>No tenants found</CommandEmpty>
            <CommandGroup>
              {showAllOption && (
                <CommandItem
                  value="__all_tenants__"
                  onSelect={() => handleSelect(undefined)}
                >
                  <span>All Tenants</span>
                  <Check
                    className={cn(
                      'ml-auto h-4 w-4',
                      !selectedTenantId ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                </CommandItem>
              )}
              {tenants.map((tenant) => (
                <CommandItem
                  key={tenant.id}
                  value={tenant.name}
                  onSelect={() => handleSelect(tenant.id)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {tenant.logo ? (
                      <img
                        src={tenant.logo}
                        alt={tenant.name}
                        className="w-5 h-5 rounded object-contain flex-shrink-0"
                      />
                    ) : (
                      <div
                        className="w-5 h-5 rounded flex items-center justify-center text-xs font-medium flex-shrink-0"
                        style={{
                          backgroundColor: tenant.primaryColor || '#6366f1',
                          color: '#fff',
                        }}
                      >
                        {tenant.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="truncate">{tenant.name}</span>
                  </div>
                  <Check
                    className={cn(
                      'ml-auto h-4 w-4',
                      selectedTenantId === tenant.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

export default TenantSelector;
