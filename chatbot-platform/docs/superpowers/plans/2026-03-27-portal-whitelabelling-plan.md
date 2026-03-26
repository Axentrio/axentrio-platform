# Portal Whitelabelling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the portal show the current org's branding (logo, name, accent color) in the shell, and apply the tenant's configured primary color as the runtime accent palette.

**Architecture:** Refactor Tailwind's hardcoded primary color scale to CSS-variable-backed values. Create a `useTenantTheme` hook that reads the tenant's `settings.theme.primaryColor`, generates an HSL palette, and writes CSS custom properties at runtime. Update the sidebar and mobile top bar to show the Clerk org's name and logo.

**Tech Stack:** React, TypeScript, Tailwind CSS, shadcn/ui, Clerk (`useOrganization`), TanStack Query

**Spec:** `docs/superpowers/specs/2026-03-27-portal-whitelabelling-design.md`

---

### Task 1: Refactor Tailwind Config to CSS-Variable-Backed Primary Scale

**Files:**
- Modify: `portal/tailwind.config.js`
- Modify: `portal/src/styles/index.css`

This is the foundation — all other tasks depend on the primary scale being driven by CSS variables.

- [ ] **Step 1: Add default primary CSS variables to `index.css`**

In `portal/src/styles/index.css`, inside the `:root` block (after line 29, after `--radius`), add:

```css
/* Primary color scale (overridden at runtime by useTenantTheme) */
--color-primary-50: #eef2ff;
--color-primary-100: #e0e7ff;
--color-primary-200: #c7d2fe;
--color-primary-300: #a5b4fc;
--color-primary-400: #818cf8;
--color-primary-500: #6366f1;
--color-primary-600: #4f46e5;
--color-primary-700: #4338ca;
--color-primary-800: #3730a3;
--color-primary-900: #312e81;
--color-primary-rgb: 99, 102, 241;
```

- [ ] **Step 2: Update `tailwind.config.js` primary scale to reference CSS variables**

Replace the hardcoded hex values in `colors.primary` (lines 29-38):

```js
primary: {
  DEFAULT: "hsl(var(--primary))",
  foreground: "hsl(var(--primary-foreground))",
  50: 'var(--color-primary-50, #eef2ff)',
  100: 'var(--color-primary-100, #e0e7ff)',
  200: 'var(--color-primary-200, #c7d2fe)',
  300: 'var(--color-primary-300, #a5b4fc)',
  400: 'var(--color-primary-400, #818cf8)',
  500: 'var(--color-primary-500, #6366f1)',
  600: 'var(--color-primary-600, #4f46e5)',
  700: 'var(--color-primary-700, #4338ca)',
  800: 'var(--color-primary-800, #3730a3)',
  900: 'var(--color-primary-900, #312e81)',
},
```

- [ ] **Step 3: Update `edge.focus` to use CSS variable**

Replace `edge.focus` (line 85):

```js
edge: {
  DEFAULT: '#2a2d3e',
  light: '#353850',
  focus: 'var(--color-primary-600, #4f46e5)',
},
```

- [ ] **Step 4: Update glow box shadows to use CSS variable**

Replace `boxShadow` glow values (lines 117-119):

```js
boxShadow: {
  'glow-sm': '0 0 10px -3px rgba(var(--color-primary-rgb, 99, 102, 241), 0.3)',
  'glow': '0 0 20px -5px rgba(var(--color-primary-rgb, 99, 102, 241), 0.4)',
  'glow-lg': '0 0 30px -5px rgba(var(--color-primary-rgb, 99, 102, 241), 0.5)',
  'card': '0 4px 24px -4px rgba(0, 0, 0, 0.3)',
  'card-hover': '0 8px 32px -4px rgba(0, 0, 0, 0.5)',
},
```

- [ ] **Step 5: Update glowPulse keyframe to use CSS variable**

Replace `glowPulse` keyframe (lines 140-143):

```js
glowPulse: {
  '0%, 100%': { boxShadow: '0 0 8px rgba(var(--color-primary-rgb, 99, 102, 241), 0.3)' },
  '50%': { boxShadow: '0 0 20px rgba(var(--color-primary-rgb, 99, 102, 241), 0.6)' },
},
```

- [ ] **Step 6: Verify the app still compiles and looks unchanged**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

Expected: no errors. The portal should look identical — CSS variables default to the same indigo values.

- [ ] **Step 7: Commit**

```bash
git add portal/tailwind.config.js portal/src/styles/index.css
git commit -m "refactor(portal): replace hardcoded primary colors with CSS variables"
```

---

### Task 2: Create `useTenantTheme` Hook

**Files:**
- Create: `portal/src/hooks/useTenantTheme.ts`

This hook reads the tenant's primary color and injects a generated palette as CSS custom properties.

- [ ] **Step 1: Create the hook file**

Create `portal/src/hooks/useTenantTheme.ts`:

```ts
import { useEffect } from 'react';
import { useTenantSettings } from '@/queries/useTenantQueries';

const DEFAULT_COLOR = '#6366f1';
const HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

/** Convert a hex color string to HSL components { h, s, l } */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l: l * 100 };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** Convert HSL components back to a hex string */
function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = ln - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Generate a full primary palette from a base hex color */
function generatePalette(baseHex: string) {
  const { h, s } = hexToHsl(baseHex);

  // Lightness steps tuned for dark UI surfaces
  const steps: Record<string, number> = {
    50: 95, 100: 90, 200: 82, 300: 71,
    400: 60, 500: 50, 600: 42, 700: 33,
    800: 24, 900: 17,
  };

  const palette: Record<string, string> = {};
  for (const [step, lightness] of Object.entries(steps)) {
    palette[step] = hslToHex(h, Math.min(s, 90), lightness);
  }

  return { palette, h, s };
}

/**
 * Reads the tenant's primaryColor from settings and applies
 * a generated color palette as CSS custom properties.
 */
export function useTenantTheme() {
  const { data } = useTenantSettings();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawColor = (data as any)?.settings?.theme?.primaryColor;
  const baseColor = typeof rawColor === 'string' && HEX_REGEX.test(rawColor)
    ? rawColor
    : DEFAULT_COLOR;

  useEffect(() => {
    const root = document.documentElement;
    const { palette, h, s } = generatePalette(baseColor);

    // Set numbered scale
    for (const [step, hex] of Object.entries(palette)) {
      root.style.setProperty(`--color-primary-${step}`, hex);
    }

    // Set RGB for glow shadows (from the 500 step)
    const r500 = parseInt(palette['500'].slice(1, 3), 16);
    const g500 = parseInt(palette['500'].slice(3, 5), 16);
    const b500 = parseInt(palette['500'].slice(5, 7), 16);
    root.style.setProperty('--color-primary-rgb', `${r500}, ${g500}, ${b500}`);

    // Set shadcn HSL tokens (format: "H S% L%")
    root.style.setProperty('--primary', `${h} ${Math.min(s, 90)}% 50%`);
    root.style.setProperty('--ring', `${h} ${Math.min(s, 90)}% 60%`);

    return () => {
      // Cleanup: remove overrides so defaults from CSS apply
      const vars = [
        ...Object.keys(palette).map((step) => `--color-primary-${step}`),
        '--color-primary-rgb', '--primary', '--ring',
      ];
      vars.forEach((v) => root.style.removeProperty(v));
    };
  }, [baseColor]);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Add barrel export**

In `portal/src/hooks/index.ts`, add:

```ts
export { useTenantTheme } from './useTenantTheme';
```

- [ ] **Step 4: Commit**

```bash
git add portal/src/hooks/useTenantTheme.ts portal/src/hooks/index.ts
git commit -m "feat(portal): add useTenantTheme hook for runtime accent color"
```

---

### Task 3: Mount Theme Hook in Auth Shell

**Files:**
- Modify: `portal/src/App.tsx`

Mount `useTenantTheme` inside `AuthenticatedLayout` so it runs for all authenticated users.

- [ ] **Step 1: Import and call `useTenantTheme` in `AuthenticatedLayout`**

At the top of `App.tsx`, add:

```ts
import { useTenantTheme } from '@/hooks/useTenantTheme';
```

Inside the `AuthenticatedLayout` component body (before the return statement), add:

```ts
useTenantTheme();
```

- [ ] **Step 2: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add portal/src/App.tsx
git commit -m "feat(portal): mount tenant theme hook in authenticated shell"
```

---

### Task 4: Update Sidebar Header with Org Branding

**Files:**
- Modify: `portal/src/components/Sidebar.tsx`

Replace the generic "HandsOff / Agent Portal" header with the Clerk org's logo and name.

- [ ] **Step 1: Add Clerk org import**

Add to the imports in `Sidebar.tsx`:

```ts
import { useOrganization } from '@clerk/clerk-react';
```

- [ ] **Step 2: Get org data in the component**

Inside the `Sidebar` component body (after `const { signOut } = useClerk();`), add:

```ts
const { organization } = useOrganization();
```

- [ ] **Step 3: Replace the header section**

Replace the `{/* Logo */}` section (lines 83-94) with:

```tsx
{/* Org branding */}
<div className="flex items-center gap-3 px-4 py-4 border-b border-edge relative">
  <div className="relative">
    <div className="absolute inset-0 bg-primary-500/20 rounded-xl blur-md" />
    {organization?.imageUrl ? (
      <img
        src={organization.imageUrl}
        alt={organization.name ?? ''}
        className="relative w-8 h-8 rounded-xl object-cover"
      />
    ) : (
      <div className="relative w-8 h-8 bg-primary-600 rounded-xl flex items-center justify-center">
        <span className="text-sm font-bold text-white">
          {organization?.name?.charAt(0)?.toUpperCase() ?? 'H'}
        </span>
      </div>
    )}
  </div>
  <div className="min-w-0 flex-1">
    <h1 className="font-bold text-text-primary truncate">
      {organization?.name ?? 'HandsOff'}
    </h1>
    <p className="text-xs text-text-muted">HandsOff</p>
  </div>
</div>
```

- [ ] **Step 4: Remove unused `useTenantSettings` import**

The `Sidebar.tsx` file currently imports `useTenantSettings` (line 23) but does not use it. Remove that import line.

- [ ] **Step 5: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add portal/src/components/Sidebar.tsx
git commit -m "feat(portal): show org logo and name in sidebar header"
```

---

### Task 5: Update Mobile Top Bar with Org Branding

**Files:**
- Modify: `portal/src/App.tsx`

The mobile top bar in `AuthenticatedLayout` currently shows a generic HandsOff logo. Update it to show the org's name and image.

- [ ] **Step 1: Import `useOrganization` in App.tsx**

Add to the imports:

```ts
import { useOrganization } from '@clerk/clerk-react';
```

- [ ] **Step 2: Get org data in `AuthenticatedLayout`**

Inside `AuthenticatedLayout`, add:

```ts
const { organization } = useOrganization();
```

- [ ] **Step 3: Update the mobile top bar**

Find the mobile top bar section (the `div` with `md:hidden` that contains the Headphones icon and "HandsOff" text). Replace the logo/name portion with:

```tsx
<div className="flex items-center gap-2">
  {organization?.imageUrl ? (
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
```

- [ ] **Step 4: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add portal/src/App.tsx
git commit -m "feat(portal): show org branding in mobile top bar"
```

---

### Task 6: Wire Tenant Settings Page to `settings.theme.primaryColor`

**Files:**
- Modify: `portal/src/types/index.ts`
- Modify: `portal/src/pages/Tenants.tsx`

The current tenant settings page has color pickers that are not wired to the backend. Wire `primaryColor` to `settings.theme.primaryColor` and remove the unsupported `secondaryColor` for now.

- [ ] **Step 0: Update TypeScript types**

In `portal/src/types/index.ts`, add `theme` to `TenantSettings`:

```ts
export interface TenantSettings {
  theme?: {
    primaryColor?: string;
    logoUrl?: string;
    customCss?: string;
  };
  businessHours: BusinessHours;
  autoHandoff: boolean;
  handoffTriggers: HandoffTriggers;
  responseTimeSLA: number; // in minutes
  csatEnabled: boolean;
}
```

Also remove `primaryColor` and `secondaryColor` from the `Tenant` interface (they are now sourced from `settings.theme`). If any component still references `tenant.primaryColor`, update it to use `tenant.settings?.theme?.primaryColor ?? '#6366f1'`.

- [ ] **Step 1: Update `mapApiToTenant` to read from `settings.theme`**

In `Tenants.tsx`, find `mapApiToTenant` (around line 39). Change:

```ts
primaryColor: '#6366f1',   // not returned by API; use default
secondaryColor: '#4338ca', // not returned by API; use default
```

To:

```ts
primaryColor: data.settings?.theme?.primaryColor || '#6366f1',
secondaryColor: '#4338ca', // not supported by backend yet
```

- [ ] **Step 2: Update `handleSave` to send `settings.theme`**

In the `handleSave` function, add the primary color to the payload. Change the function to include:

```ts
const handleSave = async (data: Partial<Tenant>) => {
  const payload: Record<string, unknown> = {};
  if (data.name) payload.name = data.name;
  if (data.webhookUrl !== undefined) payload.webhookUrl = data.webhookUrl;
  if (data.primaryColor) {
    payload.settings = {
      theme: { primaryColor: data.primaryColor },
    };
  }
  await updateMutation.mutateAsync(payload);
  setIsModalOpen(false);
};
```

- [ ] **Step 3: Remove `secondaryColor` from the modal form and card display**

In the `TenantModal` component, remove the secondary color `ColorField` from the grid. Change the grid from `grid-cols-2` to a single column, keeping only the primary color picker.

Also remove the secondary color swatch from the tenant card body (the "Primary: / Secondary:" display section). Only show the primary color swatch.

- [ ] **Step 4: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/Tenants.tsx
git commit -m "feat(portal): wire primary color to settings.theme.primaryColor"
```

---

### Task 7: Fix Backend Settings Deep Merge

**Files:**
- Modify: `api/src/routes/tenants.ts`

The current PATCH handler does a shallow merge of `settings`, which means sending `{ settings: { theme: { primaryColor } } }` would wipe `settings.features` and `settings.businessHours`. Fix this to deep-merge.

- [ ] **Step 1: Update the settings merge in the PATCH handler**

Find the settings merge block in the PATCH `/tenants/me` handler (around lines 97-103). Change:

```ts
if (settings) {
  tenant.settings = {
    ...tenant.settings,
    ...settings,
  };
}
```

To:

```ts
if (settings) {
  // Deep merge: preserve nested objects (theme, features, businessHours)
  const existing = tenant.settings || {};
  tenant.settings = {
    ...existing,
    ...settings,
    theme: { ...existing.theme, ...settings.theme },
    features: settings.features !== undefined
      ? { ...existing.features, ...settings.features }
      : existing.features,
    businessHours: settings.businessHours !== undefined
      ? { ...existing.businessHours, ...settings.businessHours }
      : existing.businessHours,
  };
}
```

- [ ] **Step 2: Verify the API compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/tenants.ts
git commit -m "fix(api): deep-merge tenant settings to preserve nested fields"
```

---

### Task 8: Manual Verification

No new files. This is the final verification pass.

- [ ] **Step 1: Full type check (portal)**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 2: Full type check (API)**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Manual checklist**

Verify these acceptance criteria by reading the code (or running locally if possible):

1. Sidebar shows Clerk org name and logo (Task 4)
2. Sidebar shows letter avatar fallback when no Clerk image (Task 4)
3. Mobile top bar shows org branding (Task 5)
4. `useTenantTheme` reads `settings.theme.primaryColor` and sets CSS variables (Task 2+3)
5. Tailwind primary scale references CSS variables with indigo fallbacks (Task 1)
6. Glow shadows and focus colors use CSS variables (Task 1)
7. Super-admin nav items still use hardcoded amber (unchanged)
8. Primary color saved through `PATCH /tenants/me` with deep merge (Task 6+7)
9. Invalid hex values fall back to default indigo (Task 2)
10. `secondaryColor` removed from branding UI (Task 6)
