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
- Keyboard shortcut: `Cmd+K` opens the command palette directly

**Active impersonation state:**
- Branding section shows the impersonated tenant's name instead of the org name
- 3px left border on the entire sidebar in `orange-500`
- Branding area gets `orange-500/10` background tint
- Subtitle changes from "HandsOff" to "Impersonating" in orange text
- A proper small "Exit" button inside the branding section (not a tiny text link)

Non-super-admin users see zero changes.

### 2. Command Palette Modal

Opens when the super admin clicks the sidebar trigger or uses the keyboard shortcut. Uses shadcn `Dialog` + `Command` components.

**Layout:**
- Centered modal, ~480px wide, max-height ~400px
- Dimmed backdrop, click-to-dismiss
- Auto-focused search input at the top
- Scrollable tenant list below

**Search input:**
- Placeholder: "Search tenants..."
- Filters list by tenant name as you type
- `Escape` closes, `Arrow keys` navigate, `Enter` selects

**Tenant list items:**
- Each row: tenant name (left), tier badge pill (right, e.g. "Pro", "Free")
- Currently impersonated tenant (if any) gets a checkmark icon and subtle highlight, pinned to top
- Remaining tenants sorted alphabetically

**Empty state:**
- "No tenants match your search"

**On selection:**
- Inline confirmation at the bottom of the modal: "Switch to **TenantName**?" with Cancel / Confirm buttons
- On confirm: sets tenant context, closes modal, invalidates all React Query caches, shows toast "Now viewing TenantName"

### 3. Content Area Banner

A full-width banner between the top bar and main content area when impersonating.

**Design:**
- Full width of content area (not sidebar)
- `orange-500/10` background with 4px orange left border accent
- Single line: pulsing dot + "You are viewing **TenantName**" (left), "Exit" button (right)
- Compact height: ~36px
- Exit button clears context, invalidates queries, shows toast "Returned to your own context"

**Why dual indicators (sidebar + banner)?**
- Sidebar indicator is always visible but becomes "wallpaper" over time
- Banner sits directly above the data being viewed — constant reminder
- Two independent exit points reduce friction

When not impersonating, the banner doesn't render. No empty space.

### 4. Query Invalidation & State Management

**On tenant switch (confirm):**
- `queryClient.invalidateQueries()` — blanket cache invalidation
- All visible queries refetch with the new `X-Tenant-Context` header
- Existing loading/skeleton states handle the transition

**On exit (clear context):**
- Same blanket invalidation, refetch as the super admin's own tenant
- `clearTenant()` on Zustand store

**Store changes:**
- No new state fields needed — existing `tenantContextStore` with `activeTenant` ({ tenantId, tenantName }) is sufficient
- Add `sessionStorage` persistence so impersonation context survives page refresh

## Components Affected

| File | Change |
|------|--------|
| `components/admin/TenantContextSwitcher.tsx` | Replace entirely — becomes the command palette modal + content banner |
| `components/Sidebar.tsx` | Modify org branding section to be clickable for super admins, add impersonation visual state |
| `stores/tenantContextStore.ts` | Add `sessionStorage` persistence via Zustand `persist` middleware |
| `App.tsx` | Move/restructure where `TenantContextSwitcher` renders (banner goes between top bar and content) |

## Out of Scope

- Recently-used tenants section (can add later)
- Tenant grouping/categorization in the list
- Mobile-specific adaptations (sidebar is hidden on mobile already)
- Changes to the backend `X-Tenant-Context` header mechanism
