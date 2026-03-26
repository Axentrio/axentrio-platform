# Settings Page Redesign + Functional Theming

## Overview

Redesign the Settings page with a vertical sidebar navigation layout and implement functional light/dark/system theme switching with accent color customization. The current Appearance tab is a non-functional stub — theme selection does nothing, no light mode CSS exists, and preferences aren't persisted.

## Goals

1. Make the theme switcher functional (light, dark, system modes)
2. Implement core light mode across main layout and key components
3. Redesign Settings page with vertical sidebar navigation
4. Add accent color picker (preset palette + custom hex)
5. Persist preferences to both localStorage (instant) and API (sync)

## Non-Goals

- Full light mode coverage of every niche component (can iterate later)
- Density/font size/sidebar position customization
- User accent color overriding org branding (org always wins)

---

## Design

### 1. Settings Page Layout

**Replace horizontal tabs with vertical sidebar navigation.**

Structure:
```
┌──────────────────────────────────────────────┐
│ Settings                                      │
│ Manage your account and preferences           │
├────────────┬─────────────────────────────────┤
│            │                                  │
│ ACCOUNT    │  [Section Title]                 │
│  Profile   │  [Section subtitle]              │
│  Notifs    │                                  │
│  Appearance│  [Content area]                  │
│            │                                  │
│ WORKSPACE  │                                  │
│  Integr.   │                                  │
│            │                                  │
└────────────┴─────────────────────────────────┘
```

- Sidebar categories: "Account" (Profile, Notifications, Appearance) and "Workspace" (Integrations)
- URL routing: `/settings/profile`, `/settings/appearance`, etc.
- Active item highlighted with accent color background
- Sidebar width: ~200px, content area takes remaining space
- On mobile (<768px): sidebar collapses to a horizontal scrollable tab bar above the content

### 2. Theme Switcher

**Three options with mini app preview thumbnails (not just icons):**

Each option shows a miniature representation of the app in that theme:
- **Light** — white/gray mini-preview showing sidebar + content area
- **Dark** — dark mini-preview showing the same layout
- **System** — split preview (half light, half dark)

Selected option gets a prominent border in the accent color. Theme applies immediately on click (no "Save Theme" button needed for theme — auto-saves).

### 3. Accent Color Picker

**Preset palette of 8 curated colors + custom hex option:**

Preset colors (all tested for contrast in both light and dark modes):
- Indigo (#6366f1) — default
- Violet (#8b5cf6)
- Pink (#ec4899)
- Amber (#f59e0b)
- Emerald (#10b981)
- Cyan (#06b6d4)
- Rose (#f43f5e)
- Blue (#3b82f6)

Custom option: opens a hex input field (with color preview swatch).

**Org branding rule:** When the org has custom branding set (via tenant theme), the accent color section is disabled with a note: "Your organization's branding is applied." The org's primary color is used and cannot be overridden.

### 4. Persistence Strategy

**Dual persistence: localStorage + API**

On theme/accent change:
1. Write to localStorage immediately (keys: `handsoff_theme`, `handsoff_accent`)
2. Fire API PATCH to user preferences (debounced, non-blocking)

On app load:
1. Read localStorage → apply theme class + accent vars before React renders (in `index.html` script)
2. After auth, fetch user preferences from API → reconcile with localStorage
3. API is source of truth; localStorage is the fast cache

This prevents flash-of-wrong-theme (FOWT) on page load.

---

## Technical Architecture

### ThemeProvider Context

New context provider wrapping the app root:

```typescript
interface ThemeContextValue {
  theme: 'light' | 'dark' | 'system';
  resolvedTheme: 'light' | 'dark'; // actual applied theme
  accent: string; // hex color
  accentSource: 'user' | 'org'; // who set it
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setAccent: (color: string) => void;
}
```

Responsibilities:
- Apply `.dark` class on `<html>` element based on theme
- Listen to `prefers-color-scheme` media query for "system" mode
- Set accent CSS variables (`--color-primary-*`) with computed shades
- Coordinate with `useTenantTheme` — org branding takes priority over user accent
- Sync to localStorage + API on change

### CSS Variable System

**Light theme (`:root` default):**
```css
:root {
  --background: 0 0% 100%;        /* white */
  --foreground: 224 71% 4%;       /* near-black */
  --surface-0: 0 0% 98%;          /* lightest gray */
  --surface-1: 0 0% 100%;         /* white */
  --surface-2: 220 14% 96%;       /* light gray */
  --surface-3: 220 13% 91%;       /* medium gray */
  --border: 220 13% 91%;
  --text-primary: 224 71% 4%;
  --text-secondary: 220 9% 46%;
  /* ... */
}
```

**Dark theme (`.dark` class — current values, cleaned up):**
```css
.dark {
  --background: 228 18% 7%;       /* current dark bg */
  --foreground: 228 47% 96%;      /* current light text */
  --surface-0: 229 21% 5%;
  --surface-1: 228 18% 7%;
  --surface-2: 227 17% 10%;
  --surface-3: 226 15% 14%;
  --border: 226 15% 16%;
  --text-primary: 228 47% 96%;
  --text-secondary: 228 20% 65%;
  /* ... */
}
```

**Tailwind config change:**
```js
module.exports = {
  darkMode: 'class',
  // ... rest stays the same since colors reference CSS vars
}
```

### Flash Prevention Script

Inline script in `index.html` `<head>` (runs before React):

```javascript
(function() {
  const stored = localStorage.getItem('handsoff_theme');
  const theme = stored || 'system';
  const dark = theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');

  const accent = localStorage.getItem('handsoff_accent');
  if (accent) {
    // Apply accent CSS variables
    document.documentElement.style.setProperty('--color-primary-500', accent);
  }
})();
```

### Core Light Mode Scope

Components that get light/dark variants in this iteration:

- **App shell:** sidebar navigation, top bar, main content area background
- **Settings page:** all sections
- **Cards & containers:** surface backgrounds, borders, shadows
- **Forms:** inputs, selects, textareas, buttons
- **Tables:** header, rows, hover states
- **Modals/dialogs:** overlay, content background
- **Typography:** headings, body text, muted text

Components deferred to a future iteration:
- Chat widget / live monitor specific components
- Analytics charts and graphs
- Complex data visualizations

### Settings Page Routing

```
/settings          → redirects to /settings/profile
/settings/profile  → Profile section
/settings/notifications → Notifications section
/settings/appearance → Appearance section
/settings/integrations → Integrations section
```

Each section is a separate component, loaded by the Settings layout wrapper that renders the sidebar.

---

## Files to Create/Modify

### New Files
- `portal/src/contexts/ThemeContext.tsx` — ThemeProvider + useTheme hook
- `portal/src/pages/settings/SettingsLayout.tsx` — sidebar layout wrapper
- `portal/src/pages/settings/AppearanceSettings.tsx` — redesigned appearance section
- `portal/src/pages/settings/ProfileSettings.tsx` — extracted from Settings.tsx
- `portal/src/pages/settings/NotificationSettings.tsx` — extracted from Settings.tsx
- `portal/src/pages/settings/IntegrationSettings.tsx` — extracted from Settings.tsx

### Modified Files
- `portal/src/styles/index.css` — light/dark CSS variable sets
- `portal/tailwind.config.js` — add `darkMode: 'class'`
- `portal/index.html` — add flash prevention script
- `portal/src/App.tsx` — wrap with ThemeProvider, update routes
- `portal/src/pages/Settings.tsx` — refactor to use new layout (may be replaced entirely)
- `portal/src/hooks/useTenantTheme.ts` — coordinate with ThemeProvider for accent priority

---

## Edge Cases

- **System theme changes while app is open:** `matchMedia` listener updates in real-time
- **User clears localStorage:** falls back to API preference on next load, or 'system' default
- **Org sets branding after user chose accent:** org branding takes over, user accent is preserved in DB but not applied
- **Org removes branding:** user's previously saved accent resurfaces
- **SSR/pre-render:** not applicable (SPA), but flash prevention script handles initial load
