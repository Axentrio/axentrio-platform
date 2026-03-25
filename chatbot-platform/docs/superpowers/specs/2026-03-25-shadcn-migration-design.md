# shadcn/ui Migration Design Spec

**Date:** 2026-03-25
**Status:** Approved
**Scope:** Replace all hand-rolled UI primitives in the handsoff-portal with shadcn/ui components

## Decisions

- **Preserve current design** — Map existing dark theme tokens (glassmorphism, glows, status colors) into shadcn's CSS variable system
- **Remove @headlessui/react** — Already unused in code, remove from package.json
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
| `--primary` | primary-600 | `#4f46e5` (button backgrounds, main CTA) |
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
| `--ring` | primary-500 | `#6366f1` (focus rings use the lighter 500 shade) |
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

### Glassmorphism Card Strategy

The current `.card` CSS class applies `bg-surface-2/80 backdrop-blur-sm border border-edge rounded-2xl shadow-card` with hover effects. shadcn's Card only provides `bg-card text-card-foreground rounded-lg border`. To preserve the glassmorphism look:

- Create a custom `card` variant in the shadcn Card component that adds `backdrop-blur-sm bg-surface-2/80 rounded-2xl shadow-card` via `cn()`.
- Override shadcn Card's default `rounded-lg` to `rounded-2xl` globally in the component file.
- Add a hover variant class for cards that need `border-edge-light shadow-card-hover` on hover.
- This is a one-time customization in `src/components/ui/card.tsx` after installation.

**Migration scope:** The `.card` CSS class is used in ~25 instances across 6 page files (Dashboard ~4, Analytics ~7, Settings ~4, Team ~8, Tenants ~1, Queue). Each `className="card ..."` div must be converted to a `<Card>` component import. This is mechanical but high-volume — handle per-page during Phase 3.

### CSS Variable Cleanup

The existing `--color-primary: #6366f1` in `index.css` will be superseded by shadcn's `--primary` variable. Remove or remap it during the CSS variable setup to avoid conflicts.

### Clerk Appearance Theming

`App.tsx` contains hardcoded hex values in the Clerk `appearance` config (e.g., `colorBackground: '#161821'`). Update these to reference the shadcn CSS variables (e.g., `hsl(var(--card))`) so the Clerk sign-in page stays in sync if tokens are later adjusted.

### Sidebar Active State

The Sidebar uses react-router-dom `NavLink` with a left-border active indicator (`bg-primary-600/10 text-primary-400 border-l-2 border-primary-500`). This pattern doesn't map to shadcn Button. Strategy: use shadcn Button ghost variant as the base, apply active styles via `NavLink`'s `className` callback with `cn()`.

### Tailwind v3 Compatibility

The project uses Tailwind 3.3.5. Use `npx shadcn@latest init` which supports Tailwind v3. Do not upgrade to Tailwind v4 as part of this migration — that's a separate effort.

### Rollback Strategy

All work happens on a feature branch. Old component files are replaced in-place (not deleted then recreated). If the migration needs to be rolled back, `git revert` the branch merge.

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
| `ChatStream.tsx` | Search → `Input`, status filter dropdown → `Select`, chat items → `Card`. |
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
- Inline confirmation modals (Rotate API Key, Regenerate Webhook Secret) → `AlertDialog` (these are raw div implementations, NOT using shared Modal.tsx)
- `alert('Passwords do not match')` → `AlertDialog` or inline form validation

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
- Browser `confirm()` dialogs → `AlertDialog`

### Tenants.tsx
- Tenant list → `Card` or `Table`
- Create/edit modal → `Dialog` + form
- API key → `Input` + copy `Button`
- Color pickers stay native
- Delete tenant `confirm()` dialog → `AlertDialog`

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
- Note: This page uses hardcoded hex colors (e.g., `bg-[#161821]`) instead of design tokens. Convert to token classes during migration.

### Additional shadcn Components to Install (Phase 3)

`tabs`, `label`, `switch`, `slider`, `skeleton`, `select`, `table`, `radio-group`, `separator`, `alert-dialog`

---

## Phase 4: Cleanup

### Remove Dependencies
- `@headlessui/react` — already unused in code, pure package.json cleanup
- `react-hot-toast` — replaced by Sonner
- `@heroicons/react` — already unused in code, pure package.json cleanup

### Keep Dependencies
- `lucide-react` — shadcn's default icon library (already installed at ^1.0.1)
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
- `.text-gradient`, `.focus-ring` utility classes
- Stagger delay classes
- Print styles
- Remove `.status-dot-*` classes (defined but unused in components)

### Toast Migration
- Replace BOTH `<Toaster>` instances from react-hot-toast in App.tsx (one in widget-test branch, one in main Clerk branch)
- Replace all `toast()` / `toast.success()` / `toast.error()` calls with Sonner's API
- Files with direct toast imports: `App.tsx` (Toaster component), `Settings.tsx` (8 toast calls). No hooks/services import toast.
- Sonner config mapping: react-hot-toast's `toastOptions.style` + `iconTheme` → Sonner's `theme="dark"` + `richColors` + `toastOptions`. Port custom styling (surface-2 background, edge border, success/error icon colors) to Sonner's prop equivalents.

### Tailwind Config
- Keep custom tokens not covered by shadcn CSS variables
- Remove tokens made redundant by shadcn's variable layer

---

## Full shadcn Component List

All components to install:

```
dialog alert-dialog badge button dropdown-menu popover command card input
textarea tooltip toggle-group sonner tabs label switch slider skeleton
select table radio-group separator
```

Total: 22 shadcn components

## Files Affected

### Modified
- `package.json` — new deps, removed deps
- `tailwind.config.js` — shadcn integration
- `src/styles/index.css` — CSS variables + class removal
- `src/App.tsx` — Toaster swap
- All 9 component files in `src/components/` + barrel `index.ts`
- All 9 page files in `src/pages/` + barrel `index.ts`

### Created
- `components.json` — shadcn config
- `src/lib/utils.ts` — cn() helper
- `src/components/ui/` — 22 shadcn component files
