import { create } from 'zustand';

interface UiStore {
  isTenantPaletteOpen: boolean;
  openTenantPalette: () => void;
  closeTenantPalette: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  isTenantPaletteOpen: false,
  openTenantPalette: () => set({ isTenantPaletteOpen: true }),
  closeTenantPalette: () => set({ isTenantPaletteOpen: false }),
}));
