# shadcn/ui Migration Design Spec

**Date:** 2026-03-25
**Status:** Approved
**Scope:** Replace all hand-rolled UI primitives in the handsoff-portal with shadcn/ui components

## Decisions

- **Preserve current design** — Map existing dark theme tokens (glassmorphism, glows, status colors) into shadcn's CSS variable system
- **Remove @headlessui/react** — Fully replaced by Radix primitives via shadcn
- **Remove react-hot-toast** — Replaced by Sonner (shadcn's toast)
- **Keep recharts as-is** — Only restyle chart containers with shadcn Card
- **Full migration** — Both `src/components/` and all page files
- **Remove dead CSS classes** — Delete custom component classes superseded by shadcn

## Approach: Foundation + Parallel

Four phases executed in order:

1. Foundation — install shadcn, map tokens
2. Shared components — migrate `src/components/`
3. Pages — migrate page files simplest-first
4. Cleanup — remove old dependencies and dead CSS

---

## Phase 1: Foundation

### Installation

Run `npx shadcn@latest init` in the portal directory. Configuration:

- TypeScript: yes
- Style: Default
- Base color: Slate (overridden by custom tokens)
- CSS variables: yes
- Component directory: `src/components/ui`
- Utility file: `src/lib/utils.ts` (provides `cn()` helper)

### Token Mapping

Map existing design tokens into shadcn's CSS variable system in the global CSS:

| shadcn variable | Current token | Value |
|---|---|---|
| `--background` | surface-1 | `#0f1117` |
| `--foreground` | text-primary | `#f1f3f9` |
| `--card` | surface-2 | `#161821` |
| `--card-foreground` | text-primary | `#f1f3f9` |
| `--popover` | surface-3 | `#1e2030` |
| `--popover-foreground` | text-primary | `#f1f3f9` |
| `--primary` | primary-600 | `#4f46e5` |
| `--primary-foreground` | white | `#ffffff` |
| `--secondary` | surface-3 | `#1e2030` |
| `--secondary-foreground` | text-secondary | `#9ca3bf` |
| `--muted` | surface-4 | `#262940` |
| `--muted-foreground` | text-muted | `#6b7194` |
| `--accent` | accent-500 | `#f59e0b` |
| `--accent-foreground` | inverse | `#0f1117` |
| `--destructive` | — | `#f87171` |
| `--border` | edge | `#2a2d3e` |
| `--input` | edge | `#2a2d3e` |
| `--ring` | primary-600 | `#4f46e5` |
| `--radius` | — | `0.75rem` |

### Tokens kept outside shadcn

These remain as custom Tailwind tokens (not part of shadcn's variable system):

- `surface-0` through `surface-4` — glassmorphism layering
- `edge-light`, `edge-focus` — hover/focus border variants
- Status colors: `status-online`, `status-away`, `status-offline`, `status-busy`
- Chat colors: `chat-bot`, `chat-human`, `chat-handsoff`, `chat-closed`
- Glow shadows (`glow-sm`, `glow`, `glow-lg`, `card`, `card-hover`)
- Animations (`pulse-slow`, `bounce-slight`, `slide-in`, `fade-in`, `fade-in-up`, `glow-pulse`)
- Noise background image

---

## Phase 2: Shared Components Migration

### Direct Replacements

| Current | shadcn Replacement | Details |
|---|---|---|
| `Modal.tsx` | `Dialog` | DialogContent/Header/Footer. Size variants via className. |
| `StatusBadge.tsx` (4 exports) | `Badge` | Custom variants for chat/user/priority. Dot-only mode as variant. |
| `NotificationBell.tsx` | `DropdownMenu` + `Badge` | Bell → DropdownMenuTrigger, list → DropdownMenuContent. |
| `TenantSelector.tsx` | `Popover` + `Command` | Combobox pattern: Popover wrapping Command with search. |
| `FilePreview.tsx` (2 exports) | `Dialog` + `Card` | Preview → Dialog, inline attachment → Card. |

### Internal Refactors

| Component | Changes |
|---|---|
| `Sidebar.tsx` | Nav items → `Button` (ghost variant) + `Tooltip`. Dropdowns → `DropdownMenu`. |
| `ChatWindow.tsx` | Inline buttons → `Button`, text input → `Textarea`, rest stays custom. |
| `ChatStream.tsx` | Search → `Input`, status filters → `ToggleGroup`, chat items → `Card`. |
| `TypingIndicator.tsx` | No change — pure animation, no shadcn equivalent. |

### shadcn Components to Install (Phase 2)

`dialog`, `badge`, `button`, `dropdown-menu`, `popover`, `command`, `card`, `input`, `textarea`, `tooltip`, `toggle-group`, `sonner`

---

## Phase 3: Pages Migration

Ordered simplest to most complex:

### Settings.tsx
- Tab navigation → `Tabs` (TabsList, TabsTrigger, TabsContent)
- Form inputs → `Input` + `Label`
- Toggles → `Switch`
- Volume control → `Slider`
- API key display → `Card` + copy `Button`

### Dashboard.tsx
- Metric cards → `Card` (CardHeader, CardContent)
- Skeleton loaders → `Skeleton`
- Status indicators → migrated `Badge`

### Queue.tsx
- Queue items → `Card` + priority `Badge`
- Accept/decline → `Button` (default/destructive)
- Priority sorting → `Select`

### Team.tsx
- Agent list → `Table` (TableHeader, TableBody, TableRow, TableCell)
- Add/edit modal → `Dialog` + form with `Input`, `Label`, `Select`
- Skills → `Badge` list

### Tenants.tsx
- Tenant list → `Card` or `Table`
- Create/edit modal → `Dialog` + form
- API key → `Input` + copy `Button`
- Color pickers stay native

### Analytics.tsx
- Time range → `Select` or `ToggleGroup`
- Chart containers → `Card`
- Performance table → `Table`
- Charts (recharts) unchanged

### LiveMonitor.tsx
- Benefits from shared component migration
- Filters → `Select` + `ToggleGroup`
- Search → `Input`

### ChatTakeover.tsx
- Benefits from shared component migration
- Transfer modal → `Dialog` + `RadioGroup`

### WidgetTest.tsx
- Connection status → `Badge`
- Message input → `Input` + `Button`
- Message bubbles stay custom

### Additional shadcn Components to Install (Phase 3)

`tabs`, `label`, `switch`, `slider`, `skeleton`, `select`, `table`, `radio-group`, `separator`

---

## Phase 4: Cleanup

### Remove Dependencies
- `@headlessui/react` — fully replaced by Radix via shadcn
- `react-hot-toast` — replaced by Sonner
- `@heroicons/react` — remove if zero imports remain (lucide-react is primary)

### Keep Dependencies
- `lucide-react` — shadcn's default icon library
- `recharts` — unchanged
- `@clerk/clerk-react`, `@tanstack/react-query`, `zustand`, `socket.io-client`, `axios`, `date-fns`, `react-router-dom` — untouched

### CSS Cleanup (`styles/index.css`)

**Remove:**
- `.card`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`
- `.input`, `.badge`, `.metric-card`

**Keep:**
- Font imports (Plus Jakarta Sans, JetBrains Mono)
- CSS variables for non-shadcn tokens (status, chat, surface-0)
- Scrollbar styling
- Text selection color
- Animation keyframes
- `.glass` utility (if still used)
- Stagger delay classes
- Print styles

### Toast Migration
- Replace `<Toaster>` from react-hot-toast with Sonner's `<Toaster>` in App.tsx
- Replace all `toast()` / `toast.success()` / `toast.error()` calls with Sonner's API

### Tailwind Config
- Keep custom tokens not covered by shadcn CSS variables
- Remove tokens made redundant by shadcn's variable layer

---

## Full shadcn Component List

All components to install:

```
dialog badge button dropdown-menu popover command card input textarea
tooltip toggle-group sonner tabs label switch slider skeleton select
table radio-group separator
```

Total: 20 shadcn components

## Files Affected

### Modified
- `package.json` — new deps, removed deps
- `tailwind.config.js` — shadcn integration
- `src/styles/index.css` — CSS variables + class removal
- `src/App.tsx` — Toaster swap
- All 10 files in `src/components/`
- All 9 files in `src/pages/`

### Created
- `components.json` — shadcn config
- `src/lib/utils.ts` — cn() helper
- `src/components/ui/` — 20 shadcn component files
