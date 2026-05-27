# Tenant Switcher Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken tenant switcher with a sidebar-integrated command palette, dual impersonation indicators, and proper cache/socket management.

**Architecture:** The sidebar's org branding section becomes a clickable trigger for super admins. Clicking it (or `Cmd+K`) opens a shadcn `CommandDialog` for searching/selecting tenants. Active impersonation is shown via sidebar visual changes + a content-area banner. On switch/exit, all tenant-scoped query caches are removed, the WebSocket reconnects, and the user is redirected to `/`.

**Tech Stack:** React, TypeScript, Zustand (with `persist` middleware), TanStack Query v5, shadcn/ui (`CommandDialog`, `Badge`), Socket.io, Tailwind CSS, Sonner (toasts), React Router v6.

---

### Task 1: Create the UI Store

**Files:**
- Create: `portal/src/stores/uiStore.ts`

- [ ] **Step 1: Create the UI store file**

```typescript
// portal/src/stores/uiStore.ts
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to `uiStore.ts`

- [ ] **Step 3: Commit**

```bash
git add portal/src/stores/uiStore.ts
git commit -m "feat(portal): add UI store for tenant palette modal state"
```

---

### Task 2: Add sessionStorage Persistence + Auth Cleanup to Tenant Context Store

**Files:**
- Modify: `portal/src/stores/tenantContextStore.ts`

- [ ] **Step 1: Add persist middleware and auth cleanup**

Replace the entire file with:

```typescript
// portal/src/stores/tenantContextStore.ts
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to `tenantContextStore.ts`

- [ ] **Step 3: Commit**

```bash
git add portal/src/stores/tenantContextStore.ts
git commit -m "feat(portal): add sessionStorage persistence to tenant context store"
```

---

### Task 3: Create the `useTenantSwitch` Hook

Centralizes all switch/exit logic: cache flush, socket reconnect, navigation, toasts.

**Files:**
- Create: `portal/src/hooks/useTenantSwitch.ts`

- [ ] **Step 1: Create the hook**

```typescript
// portal/src/hooks/useTenantSwitch.ts
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

  const flushAndRedirect = useCallback(() => {
    // Remove all tenant-scoped caches (not admin caches)
    for (const key of TENANT_SCOPED_KEYS) {
      queryClient.removeQueries({ queryKey: [key] });
    }
    // Reconnect socket so server picks up new tenant context
    reconnect();
    // Redirect to dashboard to avoid 404s on tenant-scoped routes
    navigate('/', { replace: true });
  }, [queryClient, navigate, reconnect]);

  const switchTenant = useCallback(
    (tenant: { tenantId: string; tenantName: string }) => {
      setActiveTenant(tenant);
      closeTenantPalette();
      flushAndRedirect();
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to `useTenantSwitch.ts`

- [ ] **Step 3: Commit**

```bash
git add portal/src/hooks/useTenantSwitch.ts
git commit -m "feat(portal): add useTenantSwitch hook for centralized switch/exit logic"
```

---

### Task 4: Build the Command Palette Modal

**Files:**
- Create: `portal/src/components/admin/TenantCommandPalette.tsx`

- [ ] **Step 1: Create the command palette component**

```tsx
// portal/src/components/admin/TenantCommandPalette.tsx
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to `TenantCommandPalette.tsx`

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/admin/TenantCommandPalette.tsx
git commit -m "feat(portal): add TenantCommandPalette with search, confirmation, and error states"
```

---

### Task 5: Build the Impersonation Banner

**Files:**
- Create: `portal/src/components/admin/TenantImpersonationBanner.tsx`

- [ ] **Step 1: Create the banner component**

```tsx
// portal/src/components/admin/TenantImpersonationBanner.tsx
import { useTenantContextStore } from '../../stores/tenantContextStore';
import { useTenantSwitch } from '../../hooks/useTenantSwitch';
import { Button } from '@/components/ui/button';

export function TenantImpersonationBanner() {
  const { activeTenant } = useTenantContextStore();
  const { exitTenant } = useTenantSwitch();

  if (!activeTenant) return null;

  return (
    <div className="w-full bg-orange-500/10 border-l-4 border-orange-500 px-4 py-1.5 flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm text-orange-400">
        <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
        <span>
          You are viewing <strong>{activeTenant.tenantName}</strong>
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={exitTenant}
        className="text-orange-400 hover:text-orange-300 hover:bg-orange-500/10 h-7 text-xs"
      >
        Exit
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/admin/TenantImpersonationBanner.tsx
git commit -m "feat(portal): add TenantImpersonationBanner component"
```

---

### Task 6: Update the Sidebar with Trigger + Impersonation Visual State

**Files:**
- Modify: `portal/src/components/Sidebar.tsx`

- [ ] **Step 1: Add imports to the top of Sidebar.tsx**

Add these imports after the existing imports:

```typescript
import { ChevronDown } from 'lucide-react';
import { useTenantContextStore } from '../stores/tenantContextStore';
import { useUiStore } from '../stores/uiStore';
import { useTenantSwitch } from '../hooks/useTenantSwitch';
```

- [ ] **Step 2: Add hooks inside the Sidebar component**

Inside the `Sidebar` component, after the existing hooks (`useAppAuth`, `useClerk`, `useOrganization`, `hasAccess`), add:

```typescript
  const { activeTenant } = useTenantContextStore();
  const { openTenantPalette } = useUiStore();
  const { exitTenant } = useTenantSwitch();
  const isSuperAdmin = user?.role === 'super_admin';
  const isImpersonating = isSuperAdmin && !!activeTenant;
```

- [ ] **Step 3: Replace the org branding section**

Replace the entire `{/* Org branding */}` section (lines 88-111) with:

```tsx
      {/* Org branding / Tenant switcher trigger */}
      <div
        className={cn(
          'flex items-center gap-3 px-4 py-4 border-b border-edge relative',
          isImpersonating && 'bg-orange-500/10'
        )}
      >
        <div className="relative">
          <div className={cn(
            'absolute inset-0 rounded-xl blur-md',
            isImpersonating ? 'bg-orange-500/20' : 'bg-primary-500/20'
          )} />
          {!isImpersonating && organization?.hasImage ? (
            <img
              src={organization.imageUrl}
              alt={organization.name ?? ''}
              className="relative w-8 h-8 rounded-xl object-cover"
            />
          ) : (
            <div className={cn(
              'relative w-8 h-8 rounded-xl flex items-center justify-center',
              isImpersonating ? 'bg-orange-500' : 'bg-primary-600'
            )}>
              <span className="text-sm font-bold text-white">
                {isImpersonating
                  ? activeTenant.tenantName.charAt(0).toUpperCase()
                  : organization?.name?.charAt(0)?.toUpperCase() ?? 'H'}
              </span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-bold text-text-primary truncate">
            {isImpersonating ? activeTenant.tenantName : organization?.name ?? 'HandsOff'}
          </h1>
          <p className={cn(
            'text-xs',
            isImpersonating ? 'text-orange-400 font-medium' : 'text-text-muted'
          )}>
            {isImpersonating ? 'Impersonating' : 'HandsOff'}
          </p>
        </div>
        {isSuperAdmin && !isImpersonating && (
          <button
            onClick={openTenantPalette}
            className="p-1 rounded-md hover:bg-surface-2 text-text-muted hover:text-text-primary transition-colors"
            title="Switch tenant"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        )}
        {isImpersonating && (
          <button
            onClick={exitTenant}
            className="px-2 py-1 rounded-md text-xs font-medium text-orange-400 hover:bg-orange-500/10 transition-colors"
          >
            Exit
          </button>
        )}
      </div>
```

- [ ] **Step 4: Add orange left border to the aside element when impersonating**

Replace the `<aside>` opening tag (line 83) with:

```tsx
    <aside className={cn(
      'flex flex-col w-full h-full bg-surface-0 border-r border-edge',
      isImpersonating && 'border-l-[3px] border-l-orange-500',
      className
    )}>
```

- [ ] **Step 5: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add portal/src/components/Sidebar.tsx
git commit -m "feat(portal): add tenant switcher trigger and impersonation state to sidebar"
```

---

### Task 7: Update App.tsx — Wire Up Command Palette, Banner, and Keyboard Shortcut

**Files:**
- Modify: `portal/src/App.tsx`

- [ ] **Step 1: Update imports**

Replace the `TenantContextSwitcher` import:

```typescript
// Remove this line:
import { TenantContextSwitcher } from '@components/admin/TenantContextSwitcher';

// Add these:
import { TenantCommandPalette } from '@components/admin/TenantCommandPalette';
import { TenantImpersonationBanner } from '@components/admin/TenantImpersonationBanner';
import { useUiStore } from './stores/uiStore';
import { useAppAuth } from '@auth/useAppAuth';
```

- [ ] **Step 2: Add keyboard shortcut and command palette to AuthenticatedLayout**

Replace the `AuthenticatedLayout` component (lines 55-93) with:

```tsx
const AuthenticatedLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useTenantTheme();
  const { organization } = useOrganization();
  const { openTenantPalette } = useUiStore();
  const { user } = useAppAuth();
  const isSuperAdmin = user?.role === 'super_admin';

  // Global keyboard shortcut: Cmd+K / Ctrl+K
  React.useEffect(() => {
    if (!isSuperAdmin) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        // Don't trigger inside inputs/textareas/contenteditable
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        openTenantPalette();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isSuperAdmin, openTenantPalette]);

  return (
    <div className="h-screen flex overflow-hidden bg-surface-1">
      <div className="hidden md:flex w-64 flex-shrink-0">
        <Sidebar />
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="bg-surface-0 border-b border-edge px-4 py-2 flex items-center justify-between md:hidden">
          <div className="flex items-center gap-2">
            {organization?.hasImage ? (
              <img
                src={organization.imageUrl}
                alt={organization.name ?? ''}
                className="w-7 h-7 rounded-lg object-cover"
              />
            ) : (
              <div className="w-7 h-7 bg-primary-600 rounded-lg flex items-center justify-center">
                <span className="text-xs font-bold text-white">
                  {organization?.name?.charAt(0)?.toUpperCase() ?? 'H'}
                </span>
              </div>
            )}
            <span className="font-semibold text-text-primary truncate max-w-[150px]">
              {organization?.name ?? 'HandsOff'}
            </span>
          </div>
        </div>
        <TenantImpersonationBanner />
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
      {isSuperAdmin && <TenantCommandPalette />}
    </div>
  );
};
```

Key changes:
- Removed `<TenantContextSwitcher />` from the top bar
- Top bar is now mobile-only (`md:hidden`) since desktop uses sidebar branding
- Added `<TenantImpersonationBanner />` between top bar and main content
- Added `<TenantCommandPalette />` at the root (rendered only for super admins)
- Added `Cmd+K`/`Ctrl+K` keyboard shortcut with input/textarea suppression

- [ ] **Step 3: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add portal/src/App.tsx
git commit -m "feat(portal): wire up command palette, banner, and keyboard shortcut in layout"
```

---

### Task 8: Add Auth Cleanup — Clear Tenant Context on Sign-Out / Org Change

**Files:**
- Modify: `portal/src/auth/AppAuthProvider.tsx`

- [ ] **Step 1: Add tenant context cleanup import**

Add after existing imports:

```typescript
import { useTenantContextStore } from '../stores/tenantContextStore';
```

- [ ] **Step 2: Add cleanup effect inside AppAuthProvider**

Add after the existing `useEffect` that fetches `/auth/me` (after line 129):

```typescript
  // Clear tenant impersonation context on auth state changes
  useEffect(() => {
    const { activeTenant, clearTenant } = useTenantContextStore.getState();
    if (!activeTenant) return;

    // Clear if signed out
    if (!isSignedIn) {
      clearTenant();
      return;
    }

    // Clear if user is no longer super_admin
    if (dbIds && dbIds.role !== 'super_admin') {
      clearTenant();
      return;
    }
  }, [isSignedIn, organization?.id, dbIds]);
```

- [ ] **Step 3: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add portal/src/auth/AppAuthProvider.tsx
git commit -m "feat(portal): clear tenant context on sign-out, org change, or role downgrade"
```

---

### Task 9: Add Stale Tenant Validation on App Load

**Files:**
- Modify: `portal/src/auth/AppAuthProvider.tsx`

- [ ] **Step 1: Add stale tenant validation**

Add another effect after the cleanup effect from Task 8. This validates the persisted tenant still exists and is active:

```typescript
  // Validate persisted tenant context on load
  useEffect(() => {
    if (!dbIds || dbIds.role !== 'super_admin') return;

    const { activeTenant, clearTenant } = useTenantContextStore.getState();
    if (!activeTenant) return;

    // We need to check if the tenant still exists — use a direct fetch
    // so we don't depend on query client being ready
    async function validateTenant() {
      try {
        const token = await getToken();
        const res = await fetch(
          `${API_CONFIG.baseURL}/admin/tenants/${activeTenant!.tenantId}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );
        if (!res.ok) {
          clearTenant();
          // Import toast at top of file if not already imported
          const { toast } = await import('sonner');
          toast.info('Previous tenant context is no longer available');
          return;
        }
        const json = await res.json();
        const tenant = json.data ?? json;
        if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
          clearTenant();
          const { toast } = await import('sonner');
          toast.info('Previous tenant context is no longer available');
        }
      } catch {
        // Network error — leave context as-is, will be caught by API calls
      }
    }

    validateTenant();
  }, [dbIds, getToken]);
```

- [ ] **Step 2: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add portal/src/auth/AppAuthProvider.tsx
git commit -m "feat(portal): validate persisted tenant context on app load"
```

---

### Task 10: Delete Old TenantContextSwitcher

**Files:**
- Delete: `portal/src/components/admin/TenantContextSwitcher.tsx`

- [ ] **Step 1: Verify no remaining imports of TenantContextSwitcher**

Run: `grep -r "TenantContextSwitcher" chatbot-platform/portal/src/ --include="*.tsx" --include="*.ts"`

Expected: No results (App.tsx was already updated in Task 7 to remove the import)

- [ ] **Step 2: Delete the file**

```bash
rm chatbot-platform/portal/src/components/admin/TenantContextSwitcher.tsx
```

- [ ] **Step 3: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add -u portal/src/components/admin/TenantContextSwitcher.tsx
git commit -m "refactor(portal): remove old TenantContextSwitcher component"
```

---

### Task 11: Manual Smoke Test

- [ ] **Step 1: Start the dev server**

Run: `cd chatbot-platform/portal && npm run dev`

- [ ] **Step 2: Test as super admin — default state**

1. Log in as a super admin
2. Verify the sidebar org branding section shows the org name with a `ChevronDown` icon
3. Verify non-super-admin users do NOT see the chevron icon
4. Verify the top bar no longer shows the old "Switch tenant..." button

- [ ] **Step 3: Test command palette opening**

1. Click the `ChevronDown` icon in the sidebar — palette should open
2. Press `Cmd+K` (Mac) or `Ctrl+K` (Windows) — palette should open
3. Press `Escape` — palette should close
4. Click the dimmed backdrop — palette should close
5. Focus an input field, then press `Cmd+K` — palette should NOT open

- [ ] **Step 4: Test tenant search and selection**

1. Open the palette, type a tenant name — list should filter
2. Verify tier badges show on each tenant
3. Click a tenant — confirmation bar should appear at the bottom
4. Click "Cancel" — confirmation should disappear
5. Click a tenant again, then click "Confirm" — should switch

- [ ] **Step 5: Test impersonation indicators**

1. After switching, verify:
   - Sidebar has orange left border strip
   - Sidebar branding shows impersonated tenant name with "Impersonating" subtitle
   - Content area shows orange banner with "You are viewing **TenantName**"
   - Both sidebar and banner have "Exit" buttons
2. Click "Exit" on either — should clear impersonation, redirect to dashboard, show toast

- [ ] **Step 6: Test persistence**

1. Switch to a tenant
2. Refresh the page
3. Verify impersonation persists (orange indicators still visible)
4. Sign out and back in — verify impersonation is cleared

- [ ] **Step 7: Test edge cases**

1. Verify suspended/cancelled tenants appear in the list but are not selectable
2. Verify selecting the already-active tenant closes the palette (no-op)
