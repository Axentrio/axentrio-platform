# Settings Page Redesign + Functional Theming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Settings page with vertical sidebar navigation and implement functional light/dark/system theming with accent color customization.

**Architecture:** ThemeProvider context manages theme state (`light`/`dark`/`system`) and accent color, applying a `.dark` class on `<html>` for Tailwind's class-based dark mode. CSS variables define both light (`:root`) and dark (`.dark`) color tokens. Preferences persist to localStorage (instant) + API (sync). Settings page uses vertical sidebar layout with nested routes.

**Tech Stack:** React, TypeScript, Tailwind CSS (class-based dark mode), React Router (nested routes), localStorage, Clerk user metadata

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `portal/src/contexts/ThemeContext.tsx` | ThemeProvider, useTheme hook — manages theme + accent state, applies `.dark` class, syncs localStorage/API |
| `portal/src/pages/settings/SettingsLayout.tsx` | Vertical sidebar layout wrapper for settings, renders sidebar + `<Outlet>` |
| `portal/src/pages/settings/AppearanceSettings.tsx` | Theme switcher (mini previews) + accent color picker |
| `portal/src/pages/settings/ProfileSettings.tsx` | Extracted Profile + Password sections from Settings.tsx |
| `portal/src/pages/settings/NotificationSettings.tsx` | Extracted Notification preferences from Settings.tsx |
| `portal/src/pages/settings/IntegrationSettings.tsx` | Thin wrapper that renders existing IntegrationTab |

### Modified Files
| File | Changes |
|------|---------|
| `portal/src/styles/index.css` | Move current dark values into `.dark` class, add light `:root` defaults |
| `portal/tailwind.config.js` | Add `darkMode: 'class'`, add light-aware surface/text/edge colors via CSS vars |
| `portal/index.html` | Add inline flash-prevention script in `<head>` |
| `portal/src/App.tsx` | Wrap with ThemeProvider, replace `/settings` route with nested settings routes |
| `portal/src/hooks/useTenantTheme.ts` | Export `hasTenantBranding()` check for accent picker visibility |
| `portal/src/config/constants.ts` | Add `ACCENT` storage key |

---

### Task 1: Add flash-prevention script to index.html

**Files:**
- Modify: `portal/index.html`

- [ ] **Step 1: Add inline script to `<head>`**

In `portal/index.html`, add a script tag before `</head>` that reads theme from localStorage and applies the `.dark` class before React renders:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="HandsOff Portal - Human Agent Dashboard for Chatbot Management" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
    <title>HandsOff Portal</title>
    <script>
      (function() {
        var t = localStorage.getItem('handsoff_theme') || 'system';
        var d = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        if (d) document.documentElement.classList.add('dark');
        var a = localStorage.getItem('handsoff_accent');
        if (a) document.documentElement.style.setProperty('--color-primary-500', a);
      })();
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Verify the script runs**

Run: `cd portal && npx vite build --mode development 2>&1 | head -5`
Expected: Build starts without errors (the inline script is valid JS).

- [ ] **Step 3: Commit**

```bash
git add portal/index.html
git commit -m "feat(portal): add theme flash-prevention script to index.html"
```

---

### Task 2: Configure Tailwind dark mode and CSS variable-based colors

**Files:**
- Modify: `portal/tailwind.config.js`
- Modify: `portal/src/styles/index.css`

- [ ] **Step 1: Add `darkMode: 'class'` to Tailwind config**

In `portal/tailwind.config.js`, add `darkMode: 'class'` at the top level of the config object (after `content`):

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // ... rest unchanged
```

Also update the `surface`, `edge`, and `text` color definitions to use CSS variables so they respond to theme changes. Replace lines 73-93 in the `colors` section:

```js
        // Theme-aware surface colors (via CSS variables)
        surface: {
          0: 'var(--color-surface-0)',
          1: 'var(--color-surface-1)',
          2: 'var(--color-surface-2)',
          3: 'var(--color-surface-3)',
          4: 'var(--color-surface-4)',
        },
        edge: {
          DEFAULT: 'var(--color-edge)',
          light: 'var(--color-edge-light, #353850)',
          focus: 'var(--color-primary-600, #4f46e5)',
        },
        text: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          muted: 'var(--color-text-muted, #6b7194)',
          inverse: 'var(--color-text-inverse, #0f1117)',
        },
```

- [ ] **Step 2: Restructure CSS variables for light/dark themes**

Replace the entire `:root` block in `portal/src/styles/index.css` (lines 8-53) with light defaults in `:root` and dark overrides in `.dark`:

```css
@layer base {
  :root {
    /* shadcn CSS variables — LIGHT theme defaults */
    --background: 0 0% 100%;
    --foreground: 224 71% 4%;
    --card: 0 0% 99%;
    --card-foreground: 224 71% 4%;
    --popover: 0 0% 100%;
    --popover-foreground: 224 71% 4%;
    --primary: 244 57% 58%;
    --primary-foreground: 0 0% 100%;
    --secondary: 220 14% 96%;
    --secondary-foreground: 220 9% 46%;
    --muted: 220 14% 96%;
    --muted-foreground: 220 9% 46%;
    --accent: 38 92% 50%;
    --accent-foreground: 224 71% 4%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 100%;
    --border: 220 13% 91%;
    --input: 220 13% 91%;
    --ring: 239 84% 67%;
    --radius: 0.75rem;

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

    /* Light theme surface/text tokens */
    --color-surface-0: #f8f9fb;
    --color-surface-1: #ffffff;
    --color-surface-2: #f3f4f6;
    --color-surface-3: #e5e7eb;
    --color-surface-4: #d1d5db;
    --color-edge: #e5e7eb;
    --color-edge-light: #d1d5db;
    --color-text-primary: #111827;
    --color-text-secondary: #6b7280;
    --color-text-muted: #9ca3af;
    --color-text-inverse: #f9fafb;
  }

  .dark {
    /* shadcn CSS variables — DARK theme */
    --background: 228 18% 7%;
    --foreground: 228 47% 96%;
    --card: 230 19% 11%;
    --card-foreground: 228 47% 96%;
    --popover: 230 22% 15%;
    --popover-foreground: 228 47% 96%;
    --primary: 244 57% 58%;
    --primary-foreground: 0 0% 100%;
    --secondary: 230 22% 15%;
    --secondary-foreground: 224 16% 68%;
    --muted: 232 24% 20%;
    --muted-foreground: 231 16% 49%;
    --accent: 38 92% 50%;
    --accent-foreground: 228 18% 7%;
    --destructive: 0 91% 71%;
    --destructive-foreground: 0 0% 100%;
    --border: 232 19% 20%;
    --input: 232 19% 20%;
    --ring: 239 84% 67%;

    /* Dark theme surface/text tokens */
    --color-surface-0: #0a0b0f;
    --color-surface-1: #0f1117;
    --color-surface-2: #161821;
    --color-surface-3: #1e2030;
    --color-surface-4: #262940;
    --color-edge: #2a2d3e;
    --color-edge-light: #353850;
    --color-text-primary: #f1f3f9;
    --color-text-secondary: #9ca3bf;
    --color-text-muted: #6b7194;
    --color-text-inverse: #0f1117;
  }
```

Also update the `body` rule to work in both themes. Replace the existing `body` block:

```css
  body {
    font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
    background-color: var(--color-surface-1);
    color: var(--color-text-primary);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
```

And update the `::selection` rule to remain the same (it already uses CSS vars).

Update the `glass` utility to work in both themes:

```css
  .glass {
    background-color: var(--color-surface-2);
    opacity: 0.85;
    backdrop-filter: blur(12px);
    border: 1px solid var(--color-edge);
  }
```

- [ ] **Step 3: Build to verify no errors**

Run: `cd portal && npx vite build 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add portal/tailwind.config.js portal/src/styles/index.css
git commit -m "feat(portal): add light/dark CSS variable system with Tailwind class-based dark mode"
```

---

### Task 3: Create ThemeProvider context

**Files:**
- Create: `portal/src/contexts/ThemeContext.tsx`
- Modify: `portal/src/config/constants.ts`

- [ ] **Step 1: Add ACCENT storage key to constants**

In `portal/src/config/constants.ts`, add `ACCENT` to `STORAGE_KEYS`:

```typescript
export const STORAGE_KEYS = {
  ACCESS_TOKEN: 'handsoff_access_token',
  REFRESH_TOKEN: 'handsoff_refresh_token',
  USER: 'handsoff_user',
  PREFERENCES: 'handsoff_preferences',
  THEME: 'handsoff_theme',
  ACCENT: 'handsoff_accent',
} as const;
```

- [ ] **Step 2: Create ThemeContext.tsx**

Create `portal/src/contexts/ThemeContext.tsx`:

```typescript
/**
 * Theme Context
 * Manages light/dark/system theme and accent color.
 * Applies .dark class on <html>, persists to localStorage + API.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { STORAGE_KEYS } from '@/config/constants';

type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  accent: string;
  accentSource: 'user' | 'org';
  setTheme: (theme: ThemeMode) => void;
  setAccent: (color: string) => void;
  setOrgAccent: (color: string | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme === 'system') return getSystemTheme();
  return theme;
}

function applyThemeClass(resolved: 'light' | 'dark') {
  const root = document.documentElement;
  if (resolved === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

const DEFAULT_ACCENT = '#6366f1';

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.THEME);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    return 'system';
  });

  const [accent, setAccentState] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEYS.ACCENT) || DEFAULT_ACCENT;
  });

  const [orgAccent, setOrgAccent] = useState<string | null>(null);

  const resolved = resolveTheme(theme);
  const activeAccent = orgAccent || accent;
  const accentSource: 'user' | 'org' = orgAccent ? 'org' : 'user';

  // Apply theme class whenever resolved theme changes
  useEffect(() => {
    applyThemeClass(resolved);
  }, [resolved]);

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return;

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyThemeClass(getSystemTheme());
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((newTheme: ThemeMode) => {
    setThemeState(newTheme);
    localStorage.setItem(STORAGE_KEYS.THEME, newTheme);
    applyThemeClass(resolveTheme(newTheme));
  }, []);

  const setAccent = useCallback((color: string) => {
    setAccentState(color);
    localStorage.setItem(STORAGE_KEYS.ACCENT, color);
  }, []);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        resolvedTheme: resolved,
        accent: activeAccent,
        accentSource,
        setTheme,
        setAccent,
        setOrgAccent,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd portal && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to ThemeContext.

- [ ] **Step 4: Commit**

```bash
git add portal/src/contexts/ThemeContext.tsx portal/src/config/constants.ts
git commit -m "feat(portal): create ThemeProvider context with localStorage persistence"
```

---

### Task 4: Integrate ThemeProvider into App and connect with useTenantTheme

**Files:**
- Modify: `portal/src/App.tsx`
- Modify: `portal/src/hooks/useTenantTheme.ts`

- [ ] **Step 1: Export tenant branding detection from useTenantTheme**

In `portal/src/hooks/useTenantTheme.ts`, add an import for `useTheme` and call `setOrgAccent` when tenant has a custom color. Replace the existing `useTenantTheme` function (lines 72-109):

```typescript
import { useTheme } from '@/contexts/ThemeContext';

/**
 * Reads the tenant's primaryColor from settings and applies
 * a generated color palette as CSS custom properties.
 * Also notifies ThemeProvider when org branding is active.
 */
export function useTenantTheme() {
  const { data } = useTenantSettings();
  const themeCtx = useTheme();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawColor = (data as any)?.settings?.theme?.primaryColor;
  const hasOrgBranding = typeof rawColor === 'string' && HEX_REGEX.test(rawColor);
  const baseColor = hasOrgBranding ? rawColor : DEFAULT_COLOR;

  useEffect(() => {
    // Notify ThemeProvider whether org branding is active
    themeCtx.setOrgAccent(hasOrgBranding ? rawColor : null);
  }, [hasOrgBranding, rawColor, themeCtx.setOrgAccent]);

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

    // Set shadcn HSL tokens using the actual input color's values
    const { l: baseL } = hexToHsl(baseColor);
    root.style.setProperty('--primary', `${h} ${s}% ${baseL}%`);
    root.style.setProperty('--ring', `${h} ${s}% ${Math.min(baseL + 10, 80)}%`);

    return () => {
      const vars = [
        ...Object.keys(palette).map((step) => `--color-primary-${step}`),
        '--color-primary-rgb', '--primary', '--ring',
      ];
      vars.forEach((v) => root.style.removeProperty(v));
    };
  }, [baseColor]);
}
```

Also export the helper functions so the accent picker can reuse `generatePalette`:

```typescript
export { generatePalette, hexToHsl };
```

- [ ] **Step 2: Wrap App with ThemeProvider**

In `portal/src/App.tsx`, add the import and wrap the outermost element:

Add import at top:
```typescript
import { ThemeProvider } from '@/contexts/ThemeContext';
```

Wrap the ClerkProvider return (the main branch, around line 105) with ThemeProvider. The ThemeProvider should go outside ClerkProvider so the flash prevention works even before auth loads:

```typescript
  return (
    <ThemeProvider>
      <ClerkProvider
        // ... existing props
      >
        {/* ... everything else unchanged */}
      </ClerkProvider>
    </ThemeProvider>
  );
```

Also wrap the widget-test early return (around line 96):

```typescript
  if (window.location.pathname === '/widget-test') {
    return (
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <WidgetTestRouter />
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    );
  }
```

- [ ] **Step 3: Verify it compiles**

Run: `cd portal && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add portal/src/App.tsx portal/src/hooks/useTenantTheme.ts
git commit -m "feat(portal): integrate ThemeProvider into App and connect useTenantTheme"
```

---

### Task 5: Create Settings page layout with vertical sidebar

**Files:**
- Create: `portal/src/pages/settings/SettingsLayout.tsx`

- [ ] **Step 1: Create SettingsLayout component**

Create `portal/src/pages/settings/SettingsLayout.tsx`:

```typescript
/**
 * Settings Layout
 * Vertical sidebar navigation for settings pages
 */

import React from 'react';
import { NavLink, Outlet, Navigate, useLocation } from 'react-router-dom';
import { User, Bell, Paintbrush, Plug } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SettingsNavItem {
  path: string;
  label: string;
  icon: React.ElementType;
  group: string;
}

const settingsNav: SettingsNavItem[] = [
  { path: '/settings/profile', label: 'Profile', icon: User, group: 'Account' },
  { path: '/settings/notifications', label: 'Notifications', icon: Bell, group: 'Account' },
  { path: '/settings/appearance', label: 'Appearance', icon: Paintbrush, group: 'Account' },
  { path: '/settings/integrations', label: 'Integrations', icon: Plug, group: 'Workspace' },
];

const SettingsLayout: React.FC = () => {
  const location = useLocation();

  // Redirect /settings to /settings/profile
  if (location.pathname === '/settings') {
    return <Navigate to="/settings/profile" replace />;
  }

  const groups = [...new Set(settingsNav.map((item) => item.group))];

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto p-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-text-primary">Settings</h1>
          <p className="text-text-secondary">Manage your account and preferences</p>
        </div>

        <div className="flex gap-6">
          {/* Vertical sidebar — hidden on mobile, shown as horizontal tabs */}
          <nav className="hidden md:block w-52 flex-shrink-0">
            {groups.map((group) => (
              <div key={group} className="mb-4">
                <span className="block px-3 mb-1 text-xs font-semibold text-text-muted uppercase tracking-wider">
                  {group}
                </span>
                <ul className="space-y-0.5">
                  {settingsNav
                    .filter((item) => item.group === group)
                    .map((item) => (
                      <li key={item.path}>
                        <NavLink
                          to={item.path}
                          className={({ isActive }) =>
                            cn(
                              'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                              isActive
                                ? 'bg-primary-600/10 text-primary-400'
                                : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
                            )
                          }
                        >
                          <item.icon className="w-4 h-4" />
                          {item.label}
                        </NavLink>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </nav>

          {/* Mobile horizontal tabs */}
          <nav className="md:hidden w-full mb-4 overflow-x-auto">
            <div className="flex gap-1 border-b border-edge pb-2">
              {settingsNav.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors',
                      isActive
                        ? 'bg-primary-600/10 text-primary-400'
                        : 'text-text-secondary hover:text-text-primary'
                    )
                  }
                >
                  <item.icon className="w-3.5 h-3.5" />
                  {item.label}
                </NavLink>
              ))}
            </div>
          </nav>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsLayout;
```

- [ ] **Step 2: Verify it compiles**

Run: `cd portal && npx tsc --noEmit 2>&1 | grep -i "SettingsLayout\|error" | head -10`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add portal/src/pages/settings/SettingsLayout.tsx
git commit -m "feat(portal): create SettingsLayout with vertical sidebar navigation"
```

---

### Task 6: Extract Profile and Notification settings into separate components

**Files:**
- Create: `portal/src/pages/settings/ProfileSettings.tsx`
- Create: `portal/src/pages/settings/NotificationSettings.tsx`
- Create: `portal/src/pages/settings/IntegrationSettings.tsx`

- [ ] **Step 1: Create ProfileSettings.tsx**

Create `portal/src/pages/settings/ProfileSettings.tsx`:

```typescript
/**
 * Profile Settings
 * User profile information and password management
 */

import React, { useState } from 'react';
import { User, Lock, Mail, Save, Check, Loader2 } from 'lucide-react';
import { useAppAuth, useUser } from '@auth/useAppAuth';
import { api } from '@services/apiClient';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const ProfileSettings: React.FC = () => {
  const { user } = useAppAuth();
  const { user: clerkUser } = useUser();

  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [profileData, setProfileData] = useState({
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    email: user?.email || '',
  });

  const handleSaveProfile = async () => {
    if (!clerkUser) return;
    setIsSaving(true);
    try {
      await clerkUser.update({
        firstName: profileData.firstName,
        lastName: profileData.lastName,
      });
      const fullName = [profileData.firstName, profileData.lastName].filter(Boolean).join(' ');
      await api.patch('/users/profile', { name: fullName });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch {
      // Clerk or backend update failed
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {saveSuccess && (
        <div className="p-4 bg-status-online/10 border border-status-online/20 rounded-xl flex items-center gap-2 text-status-online">
          <Check className="w-5 h-5" />
          Settings saved successfully!
        </div>
      )}

      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <User className="w-5 h-5" />
            Profile Information
          </h2>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="firstName" className="text-text-secondary">First Name</Label>
                <Input
                  id="firstName"
                  type="text"
                  value={profileData.firstName}
                  onChange={(e) => setProfileData({ ...profileData, firstName: e.target.value })}
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="lastName" className="text-text-secondary">Last Name</Label>
                <Input
                  id="lastName"
                  type="text"
                  value={profileData.lastName}
                  onChange={(e) => setProfileData({ ...profileData, lastName: e.target.value })}
                  disabled={isSaving}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="email" className="text-text-secondary">Email</Label>
              <div className="flex items-center gap-2">
                <Mail className="w-5 h-5 text-text-muted" />
                <Input
                  id="email"
                  type="email"
                  value={profileData.email}
                  disabled
                  className="flex-1"
                />
              </div>
              <p className="text-xs text-text-muted">Email cannot be changed</p>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSaveProfile} disabled={isSaving}>
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save Changes
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Lock className="w-5 h-5" />
            Password
          </h2>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-text-secondary">
            Your password is managed by Clerk. To change your password, use the Clerk user menu or visit your Clerk account settings.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default ProfileSettings;
```

- [ ] **Step 2: Create NotificationSettings.tsx**

Create `portal/src/pages/settings/NotificationSettings.tsx`:

```typescript
/**
 * Notification Settings
 * Sound, desktop, and handoff notification preferences
 */

import React, { useState } from 'react';
import { Bell, Volume2, VolumeX, Monitor } from 'lucide-react';
import { useAppAuth } from '@auth/useAppAuth';
import { useNotificationSound } from '@websocket/notificationSound';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';

const NotificationSettings: React.FC = () => {
  const { user } = useAppAuth();
  const { isMuted, toggleMute, volume, setVolume } = useNotificationSound();
  const [desktopEnabled, setDesktopEnabled] = useState(user?.preferences?.notifications?.desktop ?? true);
  const [handsoffOnly, setHandsoffOnly] = useState(user?.preferences?.notifications?.handsoffOnly ?? false);

  return (
    <Card variant="glass">
      <CardHeader>
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <Bell className="w-5 h-5" />
          Notification Preferences
        </h2>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {/* Sound notifications */}
          <div className="flex items-center justify-between p-4 bg-surface-3 rounded-xl">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-surface-2 rounded-xl">
                {isMuted ? <VolumeX className="w-5 h-5 text-text-secondary" /> : <Volume2 className="w-5 h-5 text-primary-400" />}
              </div>
              <div>
                <p className="font-medium text-text-primary">Sound Notifications</p>
                <p className="text-sm text-text-secondary">Play sounds for new messages and handoffs</p>
              </div>
            </div>
            <Switch checked={!isMuted} onCheckedChange={() => toggleMute()} />
          </div>

          {/* Volume slider */}
          {!isMuted && (
            <div className="p-4 bg-surface-3 rounded-xl">
              <Label className="text-text-secondary mb-2 block">Volume</Label>
              <Slider
                min={0}
                max={1}
                step={0.1}
                value={[volume]}
                onValueChange={([v]) => setVolume(v)}
              />
              <p className="text-sm text-text-muted mt-1">{Math.round(volume * 100)}%</p>
            </div>
          )}

          {/* Desktop notifications */}
          <div className="flex items-center justify-between p-4 bg-surface-3 rounded-xl">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-surface-2 rounded-xl">
                <Monitor className="w-5 h-5 text-primary-400" />
              </div>
              <div>
                <p className="font-medium text-text-primary">Desktop Notifications</p>
                <p className="text-sm text-text-secondary">Show browser notifications</p>
              </div>
            </div>
            <Switch checked={desktopEnabled} onCheckedChange={setDesktopEnabled} />
          </div>

          {/* Handoff only */}
          <div className="flex items-center justify-between p-4 bg-surface-3 rounded-xl">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-surface-2 rounded-xl">
                <Bell className="w-5 h-5 text-primary-400" />
              </div>
              <div>
                <p className="font-medium text-text-primary">Handoff Notifications Only</p>
                <p className="text-sm text-text-secondary">Only notify for handoff requests</p>
              </div>
            </div>
            <Switch checked={handsoffOnly} onCheckedChange={setHandsoffOnly} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default NotificationSettings;
```

- [ ] **Step 3: Create IntegrationSettings.tsx**

Create `portal/src/pages/settings/IntegrationSettings.tsx`:

```typescript
/**
 * Integration Settings
 * Thin wrapper around existing IntegrationTab
 */

import React from 'react';
import { IntegrationTab } from '@/components/settings/IntegrationTab';

const IntegrationSettings: React.FC = () => {
  return <IntegrationTab />;
};

export default IntegrationSettings;
```

- [ ] **Step 4: Verify all compile**

Run: `cd portal && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/settings/ProfileSettings.tsx portal/src/pages/settings/NotificationSettings.tsx portal/src/pages/settings/IntegrationSettings.tsx
git commit -m "feat(portal): extract settings sections into separate page components"
```

---

### Task 7: Create AppearanceSettings with theme switcher and accent picker

**Files:**
- Create: `portal/src/pages/settings/AppearanceSettings.tsx`

- [ ] **Step 1: Create the AppearanceSettings component**

Create `portal/src/pages/settings/AppearanceSettings.tsx`:

```typescript
/**
 * Appearance Settings
 * Theme switcher with mini previews and accent color picker
 */

import React, { useState } from 'react';
import { Paintbrush, Check } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type ThemeMode = 'light' | 'dark' | 'system';

const PRESET_COLORS = [
  { name: 'Indigo', hex: '#6366f1' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Cyan', hex: '#06b6d4' },
  { name: 'Rose', hex: '#f43f5e' },
  { name: 'Blue', hex: '#3b82f6' },
];

/** Mini app preview for the theme cards */
const ThemePreview: React.FC<{ mode: 'light' | 'dark' | 'system' }> = ({ mode }) => {
  if (mode === 'system') {
    return (
      <div className="w-full h-16 rounded-lg overflow-hidden flex">
        {/* Light half */}
        <div className="w-1/2 bg-[#f8f9fb] flex">
          <div className="w-[35%] bg-white border-r border-[#e5e7eb]" />
          <div className="flex-1 p-1.5">
            <div className="h-1.5 bg-[#e5e7eb] rounded w-3/5 mb-1" />
            <div className="h-1 bg-[#f0f0f0] rounded w-4/5" />
          </div>
        </div>
        {/* Dark half */}
        <div className="w-1/2 bg-[#0f1117] flex">
          <div className="flex-1 p-1.5">
            <div className="h-1.5 bg-[rgba(255,255,255,0.1)] rounded w-3/5 mb-1" />
            <div className="h-1 bg-[rgba(255,255,255,0.05)] rounded w-4/5" />
          </div>
          <div className="w-[35%] bg-[#0a0b0f] border-l border-[rgba(255,255,255,0.05)]" />
        </div>
      </div>
    );
  }

  const isLight = mode === 'light';
  return (
    <div className={cn('w-full h-16 rounded-lg overflow-hidden flex', isLight ? 'bg-[#f8f9fb]' : 'bg-[#0f1117]')}>
      <div className={cn('w-[35%]', isLight ? 'bg-white border-r border-[#e5e7eb]' : 'bg-[#0a0b0f] border-r border-[rgba(255,255,255,0.05)]')} />
      <div className="flex-1 p-1.5">
        <div className={cn('h-1.5 rounded w-3/5 mb-1', isLight ? 'bg-[#e5e7eb]' : 'bg-[rgba(255,255,255,0.1)]')} />
        <div className={cn('h-1 rounded w-4/5', isLight ? 'bg-[#f0f0f0]' : 'bg-[rgba(255,255,255,0.05)]')} />
      </div>
    </div>
  );
};

const AppearanceSettings: React.FC = () => {
  const { theme, setTheme, accent, accentSource, setAccent } = useTheme();
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customHex, setCustomHex] = useState(accent);

  const themeOptions: { mode: ThemeMode; label: string }[] = [
    { mode: 'light', label: 'Light' },
    { mode: 'dark', label: 'Dark' },
    { mode: 'system', label: 'System' },
  ];

  const isOrgBranded = accentSource === 'org';

  const handleCustomColorApply = () => {
    const hex = customHex.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      setAccent(hex);
    }
  };

  return (
    <div className="space-y-6">
      {/* Theme */}
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Paintbrush className="w-5 h-5" />
            Theme
          </h2>
          <p className="text-sm text-text-secondary">Choose your preferred theme</p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            {themeOptions.map(({ mode, label }) => (
              <button
                key={mode}
                onClick={() => setTheme(mode)}
                className={cn(
                  'p-3 rounded-xl border-2 text-center transition-all cursor-pointer',
                  theme === mode
                    ? 'border-primary-500 bg-primary-600/10'
                    : 'border-edge hover:border-edge-light'
                )}
              >
                <ThemePreview mode={mode} />
                <p className="mt-2 text-sm font-medium text-text-primary">{label}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Accent Color */}
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Paintbrush className="w-5 h-5" />
            Accent Color
          </h2>
          <p className="text-sm text-text-secondary">
            {isOrgBranded
              ? "Your organization's branding is applied"
              : 'Pick your primary accent color'}
          </p>
        </CardHeader>
        <CardContent>
          <div className={cn(isOrgBranded && 'opacity-50 pointer-events-none')}>
            <div className="flex items-center gap-3 flex-wrap">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color.hex}
                  onClick={() => {
                    setAccent(color.hex);
                    setShowCustomInput(false);
                  }}
                  className={cn(
                    'w-9 h-9 rounded-full transition-all relative',
                    accent === color.hex && !showCustomInput
                      ? 'ring-2 ring-offset-2 ring-offset-surface-1 ring-primary-500 scale-110'
                      : 'hover:scale-105'
                  )}
                  style={{ backgroundColor: color.hex }}
                  title={color.name}
                >
                  {accent === color.hex && !showCustomInput && (
                    <Check className="w-4 h-4 text-white absolute inset-0 m-auto" />
                  )}
                </button>
              ))}

              {/* Divider */}
              <div className="w-px h-6 bg-edge mx-1" />

              {/* Custom color button */}
              <button
                onClick={() => setShowCustomInput(!showCustomInput)}
                className={cn(
                  'w-9 h-9 rounded-full transition-all',
                  'bg-[conic-gradient(red,yellow,lime,aqua,blue,magenta,red)]',
                  showCustomInput
                    ? 'ring-2 ring-offset-2 ring-offset-surface-1 ring-primary-500 scale-110'
                    : 'hover:scale-105'
                )}
                title="Custom color"
              />
            </div>

            {showCustomInput && (
              <div className="mt-4 flex items-center gap-3">
                <div
                  className="w-9 h-9 rounded-lg border border-edge flex-shrink-0"
                  style={{ backgroundColor: customHex }}
                />
                <div className="flex-1">
                  <Label className="text-text-secondary text-xs mb-1 block">Hex Color</Label>
                  <Input
                    value={customHex}
                    onChange={(e) => setCustomHex(e.target.value)}
                    onBlur={handleCustomColorApply}
                    onKeyDown={(e) => e.key === 'Enter' && handleCustomColorApply()}
                    placeholder="#6366f1"
                    className="font-mono text-sm"
                  />
                </div>
              </div>
            )}
          </div>

          {isOrgBranded && (
            <p className="text-xs text-text-muted mt-3 italic">
              Accent color is managed by your organization's branding settings.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default AppearanceSettings;
```

- [ ] **Step 2: Verify it compiles**

Run: `cd portal && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add portal/src/pages/settings/AppearanceSettings.tsx
git commit -m "feat(portal): create AppearanceSettings with theme previews and accent picker"
```

---

### Task 8: Wire up routes and remove old Settings page

**Files:**
- Modify: `portal/src/App.tsx`
- Delete (soft): `portal/src/pages/Settings.tsx` (keep file but empty it / redirect)

- [ ] **Step 1: Update App.tsx routes**

In `portal/src/App.tsx`, add imports for the new settings pages and replace the single `/settings` route with nested routes.

Add imports:
```typescript
import SettingsLayout from '@pages/settings/SettingsLayout';
import ProfileSettings from '@pages/settings/ProfileSettings';
import NotificationSettings from '@pages/settings/NotificationSettings';
import AppearanceSettings from '@pages/settings/AppearanceSettings';
import IntegrationSettings from '@pages/settings/IntegrationSettings';
```

Remove the old `Settings` import:
```typescript
// Remove: import Settings from '@pages/Settings';
```

Replace the existing route (line 217):
```typescript
<Route path="/settings" element={<Settings />} />
```

With nested routes:
```typescript
<Route path="/settings" element={<SettingsLayout />}>
  <Route index element={<Navigate to="/settings/profile" replace />} />
  <Route path="profile" element={<ProfileSettings />} />
  <Route path="notifications" element={<NotificationSettings />} />
  <Route path="appearance" element={<AppearanceSettings />} />
  <Route path="integrations" element={<IntegrationSettings />} />
</Route>
```

- [ ] **Step 2: Update the Sidebar link**

The Sidebar currently links to `/settings` which will now redirect to `/settings/profile`. This works as-is, so no change needed. Verify by checking that the NavLink `isActive` logic still highlights correctly. Since the path starts with `/settings`, use `end={false}` or rely on default matching. The current `NavLink` at line 115-125 of `Sidebar.tsx` uses exact path matching via `isActive`. Update it to match any `/settings/*` path:

In `portal/src/components/Sidebar.tsx`, the `menuItems` array has `{ path: '/settings', ... }`. Change it to use a function for active state detection. Actually, React Router's `NavLink` with `to="/settings"` won't be active for `/settings/profile`. We need to either:

Option A: Change path to `/settings/profile` in menu items.
Option B: Use the `end` prop set to `false`.

Use Option A — change the path in menuItems (line 48):

```typescript
  { path: '/settings/profile', label: 'Settings', icon: Settings, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
```

Wait — that would only highlight when on profile. Better approach: keep `/settings` as path but wrap the NavLink to check if current path starts with `/settings`:

Actually the simplest fix: the `/settings` route with `<SettingsLayout>` will redirect to `/settings/profile`. So NavLink `to="/settings"` won't match `/settings/profile`. The cleanest approach is to pass `end={false}` but NavLink doesn't support that the way we need. Instead, just update the sidebar path:

In `portal/src/components/Sidebar.tsx`, update the NavLink for settings to use a custom `className` function that checks the path prefix. But actually, the simplest approach that matches existing patterns: just change the settings menu item path:

```typescript
  { path: '/settings', label: 'Settings', icon: Settings, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
```

And in the NavLink rendering, add the `end` prop conditionally. For the settings item only, we don't want exact matching. The simplest way: keep the path as `/settings` and ensure the redirect works. For the `isActive` check, React Router v6 NavLink with `to="/settings"` and without `end` prop will match `/settings/profile` because `/settings` is a prefix. Actually in React Router v6, `NavLink` without `end` matches all child routes by default. But it also adds `end` by default for index routes... Let's verify: in React Router v6, `NavLink` defaults to `end={false}` which means it matches if the path is a prefix. So `to="/settings"` will be active for `/settings/profile`. This should already work.

No changes needed to Sidebar.tsx.

- [ ] **Step 3: Verify it compiles and routes work**

Run: `cd portal && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 4: Delete the old Settings.tsx**

Delete `portal/src/pages/Settings.tsx` since it's fully replaced:

```bash
rm portal/src/pages/Settings.tsx
```

- [ ] **Step 5: Commit**

```bash
git add portal/src/App.tsx portal/src/components/Sidebar.tsx
git rm portal/src/pages/Settings.tsx
git commit -m "feat(portal): wire up settings nested routes and remove old Settings page"
```

---

### Task 9: Update Clerk appearance to respect theme

**Files:**
- Modify: `portal/src/App.tsx`

- [ ] **Step 1: Make Clerk appearance dynamic**

The Clerk `appearance` prop in App.tsx is hardcoded to dark theme colors. We need to make it theme-aware. Since ClerkProvider is inside ThemeProvider, we can use `useTheme`.

Extract the ClerkProvider into a separate component that can use the theme hook. In `portal/src/App.tsx`, create an inner component:

```typescript
const ThemedClerkProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      appearance={{
        variables: {
          colorBackground: isDark ? '#161821' : '#ffffff',
          colorInputBackground: isDark ? '#1e2030' : '#f9fafb',
          colorText: isDark ? '#f1f3f9' : '#111827',
          colorTextSecondary: isDark ? '#9ca3bf' : '#6b7280',
          colorPrimary: '#6366f1',
          colorInputText: isDark ? '#f1f3f9' : '#111827',
          colorDanger: '#f87171',
          colorSuccess: '#34d399',
          colorNeutral: isDark ? '#9ca3bf' : '#6b7280',
          borderRadius: '0.75rem',
          fontFamily: "'Plus Jakarta Sans', sans-serif",
        },
        elements: {
          card: {
            backgroundColor: isDark ? '#161821' : '#ffffff',
            border: isDark ? '1px solid #2a2d3e' : '1px solid #e5e7eb',
            boxShadow: isDark
              ? '0 25px 50px -12px rgba(0,0,0,0.5)'
              : '0 25px 50px -12px rgba(0,0,0,0.1)',
          },
          headerTitle: { color: isDark ? '#f1f3f9' : '#111827' },
          headerSubtitle: { color: isDark ? '#9ca3bf' : '#6b7280' },
          socialButtonsBlockButton: {
            backgroundColor: isDark ? '#1e2030' : '#f9fafb',
            border: isDark ? '1px solid #2a2d3e' : '1px solid #e5e7eb',
            color: isDark ? '#f1f3f9' : '#111827',
            '&:hover': { backgroundColor: isDark ? '#262940' : '#f3f4f6' },
          },
          dividerLine: { backgroundColor: isDark ? '#2a2d3e' : '#e5e7eb' },
          dividerText: { color: isDark ? '#9ca3bf' : '#6b7280' },
          formFieldLabel: { color: isDark ? '#9ca3bf' : '#6b7280' },
          formFieldInput: {
            backgroundColor: isDark ? '#1e2030' : '#ffffff',
            border: isDark ? '1px solid #2a2d3e' : '1px solid #e5e7eb',
            color: isDark ? '#f1f3f9' : '#111827',
            '&:focus': {
              borderColor: '#6366f1',
              boxShadow: '0 0 0 3px rgba(99,102,241,0.15)',
            },
          },
          formButtonPrimary: {
            backgroundColor: '#6366f1',
            '&:hover': { backgroundColor: '#818cf8' },
          },
          footerActionLink: { color: '#818cf8' },
          footerActionText: { color: isDark ? '#9ca3bf' : '#6b7280' },
          identityPreviewEditButton: { color: '#818cf8' },
          formFieldAction: { color: '#818cf8' },
          otpCodeFieldInput: {
            backgroundColor: isDark ? '#1e2030' : '#ffffff',
            border: isDark ? '1px solid #2a2d3e' : '1px solid #e5e7eb',
            color: isDark ? '#f1f3f9' : '#111827',
          },
          footer: {
            '& + div': { color: isDark ? '#9ca3bf' : '#6b7280' },
          },
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
};
```

Then in the main `App` component, replace `<ClerkProvider ...>` with `<ThemedClerkProvider>`:

```typescript
  return (
    <ThemeProvider>
      <ThemedClerkProvider>
        <QueryClientProvider client={queryClient}>
          {/* ... rest unchanged */}
        </QueryClientProvider>
      </ThemedClerkProvider>
    </ThemeProvider>
  );
```

Add the `useTheme` import if not already present:
```typescript
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
```

- [ ] **Step 2: Verify it compiles**

Run: `cd portal && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add portal/src/App.tsx
git commit -m "feat(portal): make Clerk appearance theme-aware for light/dark modes"
```

---

### Task 10: Update body background and noise texture for light mode

**Files:**
- Modify: `portal/src/styles/index.css`

- [ ] **Step 1: Fix body background for light mode**

The body rule in `index.css` has an inline SVG noise texture that only looks good on dark backgrounds. Update it to be theme-aware:

```css
  body {
    font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
    background-color: var(--color-surface-1);
    color: var(--color-text-primary);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  .dark body {
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
  }
```

Also update the scrollbar colors for light mode:

```css
  ::-webkit-scrollbar-thumb {
    background-color: var(--color-edge);
    border-radius: 9999px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background-color: var(--color-edge-light, #353850);
  }
```

And the glass utility:

```css
  .glass {
    background: color-mix(in srgb, var(--color-surface-2) 85%, transparent);
    backdrop-filter: blur(12px);
    border: 1px solid var(--color-edge);
  }
```

- [ ] **Step 2: Build to verify**

Run: `cd portal && npx vite build 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add portal/src/styles/index.css
git commit -m "feat(portal): make body background and scrollbar theme-aware"
```

---

### Task 11: Smoke test the full flow

**Files:** None (verification only)

- [ ] **Step 1: Run TypeScript check**

Run: `cd portal && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Run build**

Run: `cd portal && npx vite build`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Run dev server and visually verify**

Run: `cd portal && npx vite dev --port 4080`

Manually verify:
1. Navigate to `/settings` — should redirect to `/settings/profile`
2. Click "Appearance" in the settings sidebar
3. Click "Light" theme card — app should switch to light mode instantly
4. Click "Dark" theme card — app should switch back to dark mode
5. Click "System" — should follow OS preference
6. Click different accent colors — primary color should change
7. Refresh the page — theme should persist (no flash)
8. Check mobile viewport — settings sidebar should become horizontal tabs

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(portal): address smoke test findings for settings redesign"
```
