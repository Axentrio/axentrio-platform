# Tenant Switcher Redesign — Design Spec

**Date:** 2026-03-29
**Status:** Draft
**Scope:** Super admin tenant context switching UX overhaul

## Problem

The current tenant switcher has critical UX issues:

1. **Wrong location** — small button buried in a thin top bar, easy to miss
2. **Dangerously subtle active state** — amber badge is ignorable; super admins can forget they're impersonating and make changes to the wrong tenant
3. **No search or keyboard navigation** — flat dropdown doesn't scale beyond a handful of tenants
4. **No safety rails** — single-click switching with no confirmation, no query invalidation (stale data risk)
5. **Hand-rolled dropdown** — inconsistent with the rest of the app which uses shadcn/ui components
6. **State lost on refresh** — Zustand store resets, silently dropping impersonation context

## Approach

**Sidebar-integrated command palette.** Move the switcher into the sidebar as the top element, open a command palette modal for tenant selection, and use dual indicators (sidebar + content banner) for active impersonation state.

## Design

### 1. Sidebar Trigger

The existing org branding section at the top of the sidebar becomes a dual-purpose element for super admins.

**Default state (no impersonation):**
- Looks exactly as today for all users — org logo, org name, "HandsOff" subtitle
- Super admins only: the branding block becomes clickable/hoverable with a subtle `ChevronDown` icon on the right
- Hover tooltip: "Switch tenant"
- Keyboard shortcut: `Cmd+K` (Mac) / `Ctrl+K` (Windows/Linux) opens the command palette directly
- Shortcut is suppressed when focus is inside an input, textarea, or contenteditable element

**Active impersonation state:**
- Branding section shows the impersonated tenant's name instead of the org name
- 3px left border on the entire sidebar in `orange-500`
- Branding area gets `orange-500/10` background tint
- Subtitle changes from "HandsOff" to "Impersonating" in orange text
- A proper small "Exit" button inside the branding section (not a tiny text link)

Non-super-admin users see zero changes.

**Mobile:** The sidebar is `hidden md:flex`, so the trigger is desktop-only. Tenant switching is a super-admin power-user feature that does not need a mobile fallback. The current top-bar button will be removed entirely.

### 2. Command Palette Modal

Opens when the super admin clicks the sidebar trigger or uses the keyboard shortcut. Uses shadcn `Dialog` + `Command` components. Prior art: the existing `TenantSelector.tsx` combobox pattern can be referenced for search/select behavior.

**Layout:**
- Centered modal, ~480px wide, max-height ~400px
- Dimmed backdrop, click-to-dismiss
- Auto-focused search input at the top
- Scrollable tenant list below

**Search input:**
- Placeholder: "Search tenants..."
- Filters list by tenant name as you type
- `Escape` closes the modal (both from search and confirmation states)
- `Arrow keys` navigate the list, `Enter` selects the highlighted tenant

**Tenant list items:**
- Uses `useAdminTenantsAll()` query (limit=1000) to ensure the full list is available
- Each row: tenant name (left), tier badge pill (right, e.g. "Pro", "Free")
- Currently impersonated tenant (if any) gets a checkmark icon and subtle highlight, pinned to top
- Remaining tenants sorted alphabetically
- **Suspended/cancelled tenants:** Shown in the list with a muted style and status badge ("Suspended", "Cancelled") but are **not selectable** — clicking them does nothing
- Selecting the already-active tenant is a no-op (modal closes, no confirmation)

**Loading/error states:**
- Loading: skeleton shimmer rows while tenant list fetches
- Error: "Failed to load tenants" with a retry button

**Empty state:**
- "No tenants match your search"

**On selection:**
- Inline confirmation at the bottom of the modal: "Switch to **TenantName**?" with Cancel / Confirm buttons
- `Enter` on the confirmation confirms the switch; `Escape` dismisses back to the list
- On confirm: sets tenant context, closes modal, performs cache flush (see Section 4), redirects to `/` (dashboard), shows toast "Now viewing TenantName"

### 3. Content Area Banner

A full-width banner between the top bar and main content area when impersonating.

**Design:**
- Full width of content area (not sidebar)
- `orange-500/10` background with 4px orange left border accent
- Single line: pulsing dot + "You are viewing **TenantName**" (left), "Exit" button (right)
- Compact height: ~36px
- Exit button clears context, performs cache flush, redirects to `/`, shows toast "Returned to your own context"

**Why dual indicators (sidebar + banner)?**
- Sidebar indicator is always visible but becomes "wallpaper" over time
- Banner sits directly above the data being viewed — constant reminder
- Two independent exit points reduce friction

When not impersonating, the banner doesn't render. No empty space.

### 4. Query Invalidation, WebSockets & State Management

**On tenant switch (confirm) and on exit (clear context):**

1. `setActiveTenant()` or `clearTenant()` on Zustand store
2. `queryClient.removeQueries()` — **remove** (not just invalidate) all tenant-scoped caches to prevent stale data flash. Tenant-scoped keys include: `tenants.*`, `dashboard.*`, `analytics.*`, `conversations.*`, `handoffs.*`, `knowledge.*`, `cannedResponses.*`
3. Admin-scoped queries (`admin.*`) are **not** removed — admin endpoints are context-immune (the backend ignores `X-Tenant-Context` for `/admin/*` routes)
4. **WebSocket reconnection:** Disconnect and reconnect the socket connection so the server-side socket auth picks up the new tenant context. This ensures live monitor, chat, and handoff pages receive events for the correct tenant.
5. Redirect to `/` (dashboard) to avoid 404s from tenant-scoped routes that may not exist for the new tenant
6. Toast notification

**Theming:** Tenant theme (`useTenantTheme`) will apply during impersonation — this is intentional. It lets the super admin see the tenant's branded experience. The theme refetches naturally as part of the `/tenants/me` query after cache flush.

**Store changes:**

- `tenantContextStore.ts`: Add `sessionStorage` persistence via Zustand `persist` middleware so impersonation survives page refresh
- **Auth cleanup:** Clear persisted `activeTenant` on:
  - Clerk sign-out
  - Clerk organization change
  - User change (different user signs in)
  - Role downgrade (user is no longer super_admin)
- **Stale tenant handling:** On app load, if a persisted `activeTenant` exists, validate it against the tenant list. If the tenant no longer exists or is suspended/cancelled, auto-clear with toast "Previous tenant context is no longer available"

**New store — `uiStore.ts`:**
- A separate Zustand store for UI-only state (not persisted)
- Holds `isTenantPaletteOpen` / `openTenantPalette()` / `closeTenantPalette()`
- Decouples modal state from business state in `tenantContextStore`
- The keyboard shortcut handler and sidebar trigger both call `openTenantPalette()`

## Components Affected

| File | Change |
|------|--------|
| `components/admin/TenantContextSwitcher.tsx` | Replace entirely — becomes the command palette modal + content banner |
| `components/Sidebar.tsx` | Modify org branding section to be clickable for super admins, add impersonation visual state |
| `stores/tenantContextStore.ts` | Add `sessionStorage` persistence via Zustand `persist` middleware, add auth cleanup logic |
| `stores/uiStore.ts` | **New file** — UI-only Zustand store for modal open/close state |
| `App.tsx` | Move/restructure where `TenantContextSwitcher` renders (banner between top bar and content), register global keyboard shortcut, add auth cleanup hooks |
| `websocket/SocketContext.tsx` | Add reconnection logic that triggers on `activeTenant` change |

## Out of Scope

- Recently-used tenants section (can add later)
- Tenant grouping/categorization in the list
- Mobile tenant switching (desktop-only feature; sidebar is hidden on mobile)
- Changes to the backend `X-Tenant-Context` header mechanism
- Changes to admin endpoint context immunity (already handled server-side)
