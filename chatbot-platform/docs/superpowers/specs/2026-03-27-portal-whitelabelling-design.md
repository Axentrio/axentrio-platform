# Portal Whitelabelling — Per-Org Branding

**Date:** 2026-03-27
**Status:** Approved

## Problem

Once a user is inside the portal, the shell still looks platform-generic:

- The sidebar header always shows "HandsOff / Agent Portal"
- The mobile top bar also shows generic HandsOff branding
- The portal accent palette is hardcoded to indigo

This makes tenant context weak, especially for users who belong to multiple Clerk orgs or admins managing multiple customer environments.

## Goals

- Make the current organisation obvious in the authenticated portal shell
- Apply the tenant's configured brand color as the runtime accent color
- Reuse existing Clerk org metadata for logo/name where possible
- Reuse the existing tenant settings model and tenant endpoints
- Keep the dark surfaces, layout, and overall visual language unchanged

## Non-Goals

- Per-tenant Clerk sign-in/sign-up theming
- Full theming system for surfaces, typography, or dark/light mode
- Custom domains
- Arbitrary custom CSS
- Secondary brand color support
- New API endpoints or database schema changes

## Current Codebase Reality

The original draft had a few assumptions that do not match the repo:

- `GET /tenants/me` does **not** return a top-level `primaryColor`
- The tenant entity stores branding at `tenant.settings.theme.primaryColor`
- The portal already has `useTenantSettings()`, but it returns the raw `/tenants/me` payload
- The current tenant settings page shows `primaryColor` and `secondaryColor` controls, but those are frontend-only and are not wired to the backend shape
- The sidebar and mobile top bar both still render generic HandsOff branding
- Tailwind primary shades, glow shadows, and focus color are still hardcoded indigo values

The design below corrects those assumptions.

## Source Of Truth

### Org Identity

Use Clerk for tenant identity in the shell:

| Data | Source | Status |
|------|--------|--------|
| Org name | `useOrganization().organization?.name` | Already available |
| Org logo | `useOrganization().organization?.imageUrl` | Already available |

### Accent Color

Use the existing tenant settings payload from `GET /tenants/me`:

```ts
tenant.settings?.theme?.primaryColor
```

This remains the source of truth for v1. No new endpoint is needed.

## Design

### 1. Shell Branding

Replace the generic portal shell header with org-aware branding in both places:

- Desktop sidebar header
- Mobile top bar inside `AuthenticatedLayout`

**New shell treatment:**

- Show Clerk org image when present
- Fallback to a letter avatar using the first character of the org name
- Use the tenant accent color for the fallback avatar fill and subtle glow
- Show org name as the primary label
- Keep "HandsOff" as a small secondary label so platform identity remains visible

This makes the current organisation visible without removing the product brand entirely.

### 2. Runtime Theme Injection

Create a `useTenantTheme` hook that:

1. Reads `settings.theme.primaryColor` from `useTenantSettings()`
2. Validates the input as a hex color before writing anything to CSS
3. Falls back to the default indigo `#6366f1` when the value is missing or invalid
4. Converts the base color into an HSL-driven palette
5. Writes CSS custom properties to `document.documentElement`
6. Removes or resets tenant-specific overrides when the active org changes or the shell unmounts

The hook should mount once in the authenticated, org-scoped shell. A small branding provider or shell-level effect is preferable to scattering theme logic across components.

### 3. Tailwind Refactor

The current Tailwind config blocks runtime branding because key values are hardcoded.

Refactor these to CSS-variable-backed values with indigo fallbacks:

- `colors.primary.50` through `colors.primary.900`
- `colors.edge.focus`
- `boxShadow.glow-sm`
- `boxShadow.glow`
- `boxShadow.glow-lg`
- `keyframes.glowPulse`

Pattern:

```js
primary: {
  50: 'var(--color-primary-50, #eef2ff)',
  500: 'var(--color-primary-500, #6366f1)',
  600: 'var(--color-primary-600, #4f46e5)',
}
```

Also set:

- `--primary` for shadcn components
- `--ring` for focus rings
- RGB-based variables for glow shadows if needed, for example `--color-primary-rgb`

### 4. Themed vs Fixed Areas

**Should use tenant accent color:**

- Sidebar active nav styles
- Sidebar org avatar fallback
- Mobile top-bar org avatar fallback
- Primary buttons and interactive accents already based on `primary`
- Focus rings, selection highlights, and glow shadows
- Any component already using `bg-primary-*`, `text-primary-*`, `border-primary-*`, or shadcn `primary`

**Should stay fixed:**

- Surface/background colors
- Text colors
- Status colors
- Chat status colors
- Explicit amber super-admin navigation styles
- Clerk sign-in/sign-up screens

The super-admin amber styling is platform-owned and should not be overridden by tenant theming.

### 5. Tenant Settings Wiring

The tenant settings surface needs cleanup to match the real backend model.

For this work:

- Load branding from `settings.theme.primaryColor`
- Save branding back through `PATCH /tenants/me`
- Remove `secondaryColor` from the branding flow for now, because it is not represented in the backend tenant model

Important implementation note:

The current `PATCH /tenants/me` handler only performs a shallow merge of `settings`. If the frontend sends:

```json
{ "settings": { "theme": { "primaryColor": "#e11d48" } } }
```

it may overwrite sibling fields inside `settings.theme`.

One of these must be part of implementation:

- Deep-merge `settings.theme` on the backend, or
- Have the frontend send the full existing `settings.theme` object when updating branding

Deep-merge on the backend is the safer long-term fix.

### 6. Color Generation Strategy

Given a validated base hex color:

1. Convert hex to HSL
2. Preserve hue
3. Generate lighter and darker steps for the primary scale
4. Derive the shadcn `--primary` token from the base step
5. Derive ring and glow variants from the same hue

The palette does not need to perfectly match Tailwind's default indigo math. It just needs to produce a stable, legible range for dark UI surfaces.

Recommended practical approach:

- Keep saturation within a usable range
- Clamp very dark and very light outputs
- Bias common interactive steps (`500`/`600`) toward acceptable contrast on `surface-*`

### 7. FOUC / Loading Behaviour

Because tenant settings come from an async query, the first render may briefly show default indigo before tenant branding is applied.

Accept this for v1.

Mitigations already available:

- React Query `staleTime` is 5 minutes
- Cached tenant data will reduce repeat flashes
- The shell remains visually stable because only accent tokens change

No dedicated blocking loader is required.

## Files To Create

- `portal/src/hooks/useTenantTheme.ts`

## Files To Modify

| File | Change |
|------|--------|
| `portal/tailwind.config.js` | Replace hardcoded primary/glow/focus values with CSS-variable-backed values |
| `portal/src/components/Sidebar.tsx` | Replace generic header with Clerk org branding |
| `portal/src/App.tsx` | Apply branding to the mobile top bar and mount the tenant theme hook in the authenticated shell |
| `portal/src/pages/Tenants.tsx` | Rewire branding UI to `settings.theme.primaryColor`; remove or defer unsupported `secondaryColor` handling |
| `api/src/routes/tenants.ts` | Ensure branding updates preserve nested `settings.theme` fields when saving |

## Acceptance Criteria

- Sidebar shows Clerk org name and logo when available
- Sidebar falls back to a letter avatar when the org has no image
- Mobile top bar also reflects the current org instead of generic HandsOff-only branding
- Changing `settings.theme.primaryColor` updates the portal accent color after save
- Missing or invalid brand color falls back to indigo safely
- Super-admin amber navigation remains amber
- Existing dark surfaces and text colors remain unchanged
- Components using primary utility classes update automatically via CSS variables
- Tenant branding changes do not wipe unrelated tenant settings

## Testing

- Verify desktop sidebar branding for orgs with and without Clerk images
- Verify mobile top bar branding
- Verify runtime theme application on first authenticated load and on tenant refresh
- Verify `PATCH /tenants/me` preserves existing `settings.features` and `settings.businessHours`
- Verify invalid values such as malformed hex strings fall back to default indigo
- Verify sign-in/sign-up UI remains unchanged
- Verify super-admin pages keep their explicit amber accent styling
