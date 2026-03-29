import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface TenantContext {
  tenantId: string;
  tenantName: string;
}

interface TenantContextStore {
  activeTenant: TenantContext | null;
  setActiveTenant: (tenant: TenantContext | null) => void;
  clearTenant: () => void;
}

export const useTenantContextStore = create<TenantContextStore>()(
  persist(
    (set) => ({
      activeTenant: null,
      setActiveTenant: (tenant) => set({ activeTenant: tenant }),
      clearTenant: () => set({ activeTenant: null }),
    }),
    {
      name: 'tenant-context',
      storage: createJSONStorage(() => sessionStorage),
    }
  )
);
