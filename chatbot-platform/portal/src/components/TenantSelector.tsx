/**
 * TenantSelector Component
 * Dropdown for filtering by tenant
 */

import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, Building2, Check } from 'lucide-react';
import type { Tenant } from '@app-types/index';

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
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Filter tenants based on search
  const filteredTenants = tenants.filter((tenant) =>
    tenant.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Get selected tenant name
  const selectedTenant = tenants.find((t) => t.id === selectedTenantId);

  const handleSelect = (tenantId: string | undefined) => {
    onSelect(tenantId);
    setIsOpen(false);
    setSearchQuery('');
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          w-full flex items-center justify-between gap-2 px-3 py-2
          border rounded-xl text-left text-sm
          transition-colors duration-200
          ${disabled
            ? 'bg-surface-3 border-edge text-text-muted cursor-not-allowed'
            : 'bg-surface-3 border-edge text-text-primary hover:border-edge-light focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30'
          }
        `}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Building2 className="w-4 h-4 text-text-muted flex-shrink-0" />
          <span className="truncate">
            {selectedTenant ? selectedTenant.name : placeholder}
          </span>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-text-muted flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-surface-2 border border-edge rounded-xl shadow-card max-h-60 overflow-auto">
          {/* Search input */}
          <div className="sticky top-0 bg-surface-2 border-b border-edge p-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tenants..."
              className="w-full px-3 py-1.5 text-sm bg-surface-3 border border-edge rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500/30"
              onClick={(e) => e.stopPropagation()}
            />
          </div>

          {/* All option */}
          {showAllOption && (
            <button
              type="button"
              onClick={() => handleSelect(undefined)}
              className={`
                w-full flex items-center justify-between px-3 py-2 text-sm
                hover:bg-surface-3 transition-colors
                ${!selectedTenantId ? 'bg-primary-600/10 text-primary-400' : 'text-text-secondary'}
              `}
            >
              <span>All Tenants</span>
              {!selectedTenantId && <Check className="w-4 h-4" />}
            </button>
          )}

          {/* Tenant list */}
          {filteredTenants.length > 0 ? (
            filteredTenants.map((tenant) => (
              <button
                key={tenant.id}
                type="button"
                onClick={() => handleSelect(tenant.id)}
                className={`
                  w-full flex items-center justify-between px-3 py-2 text-sm
                  hover:bg-surface-3 transition-colors
                  ${selectedTenantId === tenant.id ? 'bg-primary-600/10 text-primary-400' : 'text-text-secondary'}
                `}
              >
                <div className="flex items-center gap-2">
                  {tenant.logo ? (
                    <img
                      src={tenant.logo}
                      alt={tenant.name}
                      className="w-5 h-5 rounded object-contain"
                    />
                  ) : (
                    <div
                      className="w-5 h-5 rounded flex items-center justify-center text-xs font-medium"
                      style={{
                        backgroundColor: tenant.primaryColor || '#6366f1',
                        color: '#fff'
                      }}
                    >
                      {tenant.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="truncate">{tenant.name}</span>
                </div>
                {selectedTenantId === tenant.id && <Check className="w-4 h-4" />}
              </button>
            ))
          ) : (
            <div className="px-3 py-4 text-sm text-text-muted text-center">
              No tenants found
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TenantSelector;
