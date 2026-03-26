import { create } from 'zustand';

interface TenantContext {
  tenantId: string;
  tenantName: string;
}

interface TenantContextStore {
  activeTenant: TenantContext | null;
  setActiveTenant: (tenant: TenantContext | null) => void;
  clearTenant: () => void;
}

export const useTenantContextStore = create<TenantContextStore>((set) => ({
  activeTenant: null,
  setActiveTenant: (tenant) => set({ activeTenant: tenant }),
  clearTenant: () => set({ activeTenant: null }),
}));
