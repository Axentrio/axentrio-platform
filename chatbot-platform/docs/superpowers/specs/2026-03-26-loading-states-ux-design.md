# Loading States & UX Feedback Design

## Goal

Add consistent loading states, optimistic updates, and error feedback across all portal pages so that every user action has clear, immediate visual feedback.

## Background

The portal currently has:
- **Sonner toasts** for success/error notifications
- **Button-level spinners** (`Loader2 + animate-spin`) during mutations
- **Skeleton loaders** on the Team page only
- **React Query** with `useMutation` hooks in `useAdminQueries.ts`, `useTenantQueries.ts`, `useAgentQueries.ts`

### Gaps

- Modals/dialogs show only a button spinner during submission — no form-level disabled state or overlay
- Table row mutations (role change, suspend/activate) happen silently with no row-level feedback
- No optimistic updates — every action waits for server response
- Initial page loads use centered spinners instead of content-shaped skeletons (except Team page)
- Error handling is toast-only — no inline error messages on forms
- Patterns are inconsistent across pages

## Approach

Hybrid: shared UI components + light conventions. No heavy mutation wrapper abstraction. Existing mutation hooks stay as-is; we add better UI around them.

## Architecture

### New Shared Components

All live in `portal/src/components/ui/`.

#### 1. `LoadingOverlay`

Semi-transparent overlay with centered spinner. Placed inside modals/dialogs during form submission. Blocks interaction and communicates "processing."

```
Props:
  isLoading: boolean     — controls visibility
  message?: string       — optional text below spinner (e.g. "Creating tenant...")
```

Renders as an absolutely-positioned div with `bg-surface-0/70 backdrop-blur-[2px]`, `z-50`, centered `Loader2` spinner, and optional message text. Uses the surface color for consistency with the dark theme. Only renders when `isLoading` is true.

#### 2. `PageSkeleton`

Content-shaped skeleton placeholders for initial page loads. Uses the existing `Skeleton` component internally.

```
Props:
  variant: 'table' | 'cards' | 'list'
  rows?: number          — number of skeleton rows/cards (default: 5)
```

Variants:
- `table` — a header bar skeleton + N table row skeletons with column-width variation
- `cards` — a grid of card-shaped skeletons (2-3 columns)
- `list` — stacked list item skeletons with avatar + text lines

#### 3. `InlineError`

Small red error message for forms/dialogs. Renders below a field or at the bottom of a form.

```
Props:
  message?: string | null   — when null/undefined, renders nothing
```

Renders as a `text-sm text-red-500` paragraph with a small error icon.

### New Hook

#### `useOptimisticToggle`

Lives in `portal/src/hooks/useOptimisticToggle.ts`.

Wraps React Query's `useMutation` with cache-level optimistic updates for simple one-click actions.

```typescript
useOptimisticToggle<TData, TVariables>({
  queryKey: QueryKey,
  mutationFn: (variables: TVariables) => Promise<TData>,
  updateCache: (oldData: TData, variables: TVariables) => TData,
  successMessage?: string,
  errorMessage?: string,
})
```

Behavior:
1. **On mutate** — snapshot current cache, call `updateCache` to patch it immediately
2. **On success** — show success toast, invalidate query to sync with server
3. **On error** — roll back cache to snapshot, show error toast
4. **On settled** — always invalidate to ensure consistency

This hook always shows toasts for success/error. It is not intended for use inside dialogs where `InlineError` is preferred.

Applies to:
- Tenant suspend/activate (AdminTenants)
- User promote/demote (AdminUsers)
- Member role changes (Team)
- Agent status toggles (Team)
- Member deactivate/reactivate (Team)

Does NOT apply to (stays server-confirmed):
- All create/invite form submissions — need server validation
- Delete operations — too risky for optimistic

### Patterns

#### Modal/Dialog Submission

Applied to every form-submitting modal across the portal.

1. **On submit** — disable all form inputs and buttons, render `LoadingOverlay` inside the dialog
2. **On success** — close dialog, show success toast, invalidate queries
3. **On error** — remove overlay, re-enable inputs, show `InlineError` at bottom of form with the server error message (no toast — user is still in the dialog)
4. **Double-submit prevention** — button `disabled={isPending}`, overlay blocks pointer events

Affected dialogs:
- AdminTenants: create tenant
- AdminTenantDetail: rotate API key, webhook config
- Team: invite member, create agent
- Settings: config forms
- Tenants: tenant settings

#### Row-Level Mutation Feedback

For inline table/list actions, provide visual feedback on the specific row being mutated.

- Track `mutatingRowIds: Set<string>` state in each page component (supports concurrent row mutations)
- When a mutation fires, add the target row's ID to the set
- Conditionally apply `opacity-60 pointer-events-none` to rows in the set
- Show a small spinner next to the action button
- Disable other action buttons on the same row
- Remove the row ID from the set on `onSettled`

This is a lightweight pattern using existing Tailwind classes — no new component needed.

Note: For actions using `useOptimisticToggle`, the cache updates instantly so the row won't appear "loading" — the row-level feedback is a fallback for non-optimistic mutations or the brief moment before cache updates.

#### Page-Level Skeleton Loading

Replace centered `Loader2` spinners with `PageSkeleton` on initial data fetch.

| Page | Variant | Notes |
|------|---------|-------|
| AdminTenants | `table` | Header filters bar + table rows |
| AdminUsers | `table` | Header filters bar + table rows |
| AdminAuditLogs | `table` | Header filters bar + table rows |
| Team | `list` | Already has skeletons — standardize to use `PageSkeleton` |
| Monitor | `list` | Chat session list |
| Queue | `list` | Handoff request list |
| Dashboard | `cards` | Stats cards + chart placeholders |
| Analytics | `cards` | Stats + chart placeholders |
| Settings | `list` | Settings sections |

Pattern: replace `if (isLoading) return <Loader2 .../>` with `if (isLoading) return <PageSkeleton variant="table" />`.

## Error Handling Strategy

- **Form/dialog errors** — `InlineError` at bottom of form, no toast (user is in context)
- **Background refetch errors** — Sonner toast (existing global handler in `queryConfig.ts`)
- **Inline action errors** — Sonner toast (user isn't in a focused dialog)
- **Optimistic rollback errors** — Sonner toast + cache rollback (automatic via `useOptimisticToggle`)

No retry buttons — YAGNI for now. Users can re-click the action.

## Files Changed

### New files
- `portal/src/components/ui/loading-overlay.tsx`
- `portal/src/components/ui/page-skeleton.tsx`
- `portal/src/components/ui/inline-error.tsx`
- `portal/src/hooks/useOptimisticToggle.ts`

### Modified files
- `portal/src/pages/admin/AdminTenants.tsx` — skeleton, modal overlay, row feedback, optimistic toggles
- `portal/src/pages/admin/AdminUsers.tsx` — skeleton, modal overlay, row feedback, optimistic toggles
- `portal/src/pages/admin/AdminAuditLogs.tsx` — skeleton
- `portal/src/pages/admin/AdminTenantDetail.tsx` — modal overlay for API key rotation
- `portal/src/pages/Team.tsx` — skeleton standardization, modal overlay, row feedback, optimistic toggles
- `portal/src/pages/Monitor.tsx` — skeleton
- `portal/src/pages/Queue.tsx` — skeleton
- `portal/src/pages/Dashboard.tsx` — skeleton
- `portal/src/pages/Analytics.tsx` — skeleton
- `portal/src/pages/Settings.tsx` — skeleton
- `portal/src/queries/useAdminQueries.ts` — refactor suspend/activate/promote/demote to use `useOptimisticToggle`
- `portal/src/queries/useTenantQueries.ts` — refactor role change/deactivate/reactivate to use `useOptimisticToggle`
- `portal/src/queries/useAgentQueries.ts` — refactor status toggle to use `useOptimisticToggle`

## Out of Scope

- Retry buttons on failed mutations
- Optimistic updates for create/delete operations
- Animated transitions between loading and loaded states
- Global loading bar (NProgress-style)
- Offline support or request queuing
