# Loading States & UX Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add consistent loading states, optimistic updates, and error feedback across all portal pages.

**Architecture:** Create three shared UI components (`LoadingOverlay`, `PageSkeleton`, `InlineError`), then apply them page-by-page. For optimistic updates, add targeted optimistic mutation variants directly inside `useAdminQueries.ts`, `useTenantQueries.ts`, and `useAgentQueries.ts` using the real cache shapes already stored by React Query. Do not add a generic cache wrapper unless the cached data is first normalized to a single shape.

**Tech Stack:** React, TypeScript, TanStack React Query, Tailwind CSS, shadcn/ui, Sonner toasts, Lucide icons

**Spec:** `docs/superpowers/specs/2026-03-26-loading-states-ux-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `portal/src/components/ui/loading-overlay.tsx` | Semi-transparent overlay with spinner for modals/dialogs |
| `portal/src/components/ui/page-skeleton.tsx` | Content-shaped skeleton variants (table, cards, list) |
| `portal/src/components/ui/inline-error.tsx` | Small red error message for forms |

### Modified files
| File | Changes |
|------|---------|
| `portal/src/pages/admin/AdminTenants.tsx` | PageSkeleton, LoadingOverlay in create dialog, optimistic suspend/activate |
| `portal/src/pages/admin/AdminUsers.tsx` | PageSkeleton, row feedback, optimistic promote/demote |
| `portal/src/pages/admin/AdminTenantDetail.tsx` | PageSkeleton, LoadingOverlay in API key dialog, switch suspend/activate if legacy admin hooks are removed |
| `portal/src/pages/admin/AdminAuditLogs.tsx` | PageSkeleton |
| `portal/src/pages/Team.tsx` | PageSkeleton, LoadingOverlay in modals, optimistic role/status toggles |
| `portal/src/pages/Dashboard.tsx` | Already has `MetricCardSkeleton` and `PerformanceSkeleton` — no changes needed |
| `portal/src/pages/Queue.tsx` | PageSkeleton, keep existing optimistic removal behavior, optional button-level pending feedback |
| `portal/src/pages/Analytics.tsx` | Already has `ChartSkeleton` and `TableSkeleton` — no changes needed |
| `portal/src/pages/Settings.tsx` | Standardize spinners, disable interactive controls during save |
| `portal/src/pages/LiveMonitor.tsx` | PageSkeleton (if applicable — may be WebSocket-driven) |
| `portal/src/pages/Tenants.tsx` | LoadingOverlay in tenant settings dialog |
| `portal/src/queries/useAdminQueries.ts` | Add targeted optimistic variants for suspend/activate/promote/demote against plain-array caches |
| `portal/src/queries/useTenantQueries.ts` | Add targeted optimistic variants for role change/deactivate/reactivate against plain-array caches |
| `portal/src/queries/useAgentQueries.ts` | Add optimistic status variant against the actual agent list query key used by the page |

---

### Task 1: Create `InlineError` Component

**Files:**
- Create: `portal/src/components/ui/inline-error.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface InlineErrorProps {
  message?: string | null;
  className?: string;
}

export function InlineError({ message, className }: InlineErrorProps) {
  if (!message) return null;

  return (
    <div className={cn('flex items-center gap-1.5 text-sm text-red-500', className)}>
      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
      <span>{message}</span>
    </div>
  );
}
```

- [ ] **Step 2: Verify it renders**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors related to inline-error.tsx

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/ui/inline-error.tsx
git commit -m "feat(portal): add InlineError component for form error display"
```

---

### Task 2: Create `LoadingOverlay` Component

**Files:**
- Create: `portal/src/components/ui/loading-overlay.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LoadingOverlayProps {
  isLoading: boolean;
  message?: string;
  className?: string;
}

export function LoadingOverlay({ isLoading, message, className }: LoadingOverlayProps) {
  if (!isLoading) return null;

  return (
    <div
      className={cn(
        'absolute inset-0 z-50 flex flex-col items-center justify-center',
        'bg-surface-0/70 backdrop-blur-[2px] rounded-lg',
        className,
      )}
    >
      <Loader2 className="w-6 h-6 animate-spin text-primary-400" />
      {message && (
        <p className="mt-2 text-sm text-text-secondary">{message}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify it renders**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors related to loading-overlay.tsx

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/ui/loading-overlay.tsx
git commit -m "feat(portal): add LoadingOverlay component for modal submission feedback"
```

---

### Task 3: Create `PageSkeleton` Component

**Files:**
- Create: `portal/src/components/ui/page-skeleton.tsx`

Reference: The existing `Skeleton` component at `portal/src/components/ui/skeleton.tsx` is a simple div with `animate-pulse rounded-md bg-muted`. Dashboard already has `MetricCardSkeleton` and `PerformanceSkeleton` as local components. Analytics has `ChartSkeleton` and `TableSkeleton` locally. We create a reusable version for the common patterns.

- [ ] **Step 1: Create the component**

```tsx
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface PageSkeletonProps {
  variant: 'table' | 'cards' | 'list';
  rows?: number;
  className?: string;
}

export function PageSkeleton({ variant, rows = 5, className }: PageSkeletonProps) {
  return (
    <div className={cn('p-6 space-y-6', className)}>
      {variant === 'table' && <TableSkeleton rows={rows} />}
      {variant === 'cards' && <CardsSkeleton rows={rows} />}
      {variant === 'list' && <ListSkeleton rows={rows} />}
    </div>
  );
}

function TableSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {/* Filter/search bar */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-64 rounded-lg" />
        <Skeleton className="h-9 w-32 rounded-lg" />
        <Skeleton className="h-9 w-32 rounded-lg" />
      </div>
      {/* Table header */}
      <div className="flex items-center gap-4 px-4 py-3">
        <Skeleton className="h-4 w-1/4" />
        <Skeleton className="h-4 w-1/6" />
        <Skeleton className="h-4 w-1/6" />
        <Skeleton className="h-4 w-1/5" />
        <Skeleton className="h-4 w-20" />
      </div>
      {/* Table rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-4 border-t border-edge">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-4 w-1/6" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-1/5" />
          <Skeleton className="h-8 w-20 rounded-lg" />
        </div>
      ))}
    </>
  );
}

function CardsSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: Math.min(rows, 4) }).map((_, i) => (
          <div key={i} className="p-6 rounded-xl border border-edge bg-surface-1">
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-16" />
              </div>
              <Skeleton className="w-12 h-12 rounded-xl" />
            </div>
          </div>
        ))}
      </div>
      {/* Chart placeholder */}
      <Skeleton className="h-64 w-full rounded-xl" />
    </>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {/* Header area */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-9 w-32 rounded-lg" />
      </div>
      {/* List items */}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 p-4 rounded-xl border border-edge">
          <Skeleton className="w-10 h-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
      ))}
    </>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/ui/page-skeleton.tsx
git commit -m "feat(portal): add PageSkeleton component with table/cards/list variants"
```

---

### Task 4: Establish the Optimistic Update Pattern

**Files:**
- No new file in this task

Reference: The current portal does not cache one uniform response shape. Most affected queries cache plain arrays because the API client unwraps `{ success, data }` envelopes before values reach React Query. Because of that, a generic `useOptimisticToggle` wrapper is more error-prone than direct optimistic mutations in the query modules.

- [ ] **Step 1: Do not create `portal/src/hooks/useOptimisticToggle.ts`**

Implement optimistic updates directly inside the query modules in Tasks 13-15.

- [ ] **Step 2: Use the actual cached shapes**

When writing optimistic mutations later in this plan, update the real cached values:
- `queryKeys.admin.tenants()` -> tenant array
- `queryKeys.admin.users()` -> user array
- `queryKeys.tenants.members()` -> member array
- `queryKeys.agents.list(filters)` -> agent array for the exact list key used by the page

- [ ] **Step 3: Keep the mutation lifecycle consistent**

Each optimistic mutation should:
1. Cancel matching queries
2. Snapshot previous cache data
3. Apply an immediate cache update
4. Roll back on error
5. Invalidate on settled
6. Show toasts for inline action success/error

---

### Task 5: Apply Loading States to AdminTenants

**Files:**
- Modify: `portal/src/pages/admin/AdminTenants.tsx`

Reference: Currently uses `Loader2` centered spinner (line ~186-190). Create dialog is an `AlertDialog` with `createMutation.isPending` on the button (line ~333). Suspend/activate use separate `useSuspendTenant()`/`useActivateTenant()` mutations.

- [ ] **Step 1: Replace loading spinner with PageSkeleton**

Find the loading block (approximately lines 186-190):
```tsx
{isLoading ? (
  <div className="flex items-center justify-center h-48">
    <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
    <span className="ml-2 text-text-secondary">Loading tenants...</span>
  </div>
)
```

Replace with:
```tsx
{isLoading ? (
  <PageSkeleton variant="table" rows={5} />
)
```

Add import at top of file:
```tsx
import { PageSkeleton } from '@/components/ui/page-skeleton';
```

- [ ] **Step 2: Add LoadingOverlay + InlineError to create tenant dialog**

Before wiring the dialog, keep the existing payload shape used by the page (`{ name, tier, adminEmail? }`) unless the backend contract is verified and `useCreateTenant()` is updated in the same change. Do not tighten the dialog code around `slug` / `ownerEmail` / `ownerName` based only on the current hook type.

Add imports:
```tsx
import { LoadingOverlay } from '@/components/ui/loading-overlay';
import { InlineError } from '@/components/ui/inline-error';
```

Add error state:
```tsx
const [createError, setCreateError] = useState<string | null>(null);
```

Wrap the `AlertDialogContent` inner area with `relative` positioning so the overlay works:
- Add `className="relative"` to the content wrapper div inside `AlertDialogContent`
- Add `<LoadingOverlay isLoading={createMutation.isPending} message="Creating tenant..." />` as the first child of that relative div
- Add `<InlineError message={createError} className="mt-2" />` above the `AlertDialogFooter`

Update the mutation call to clear/set error:
```tsx
onClick={() => {
  setCreateError(null);
  createMutation.mutate(data, {
    onSuccess: () => {
      setShowCreate(false);
      setNewTenant({ name: '', tier: 'free', adminEmail: '' });
      setCreateError(null);
    },
    onError: (error: any) => {
      setCreateError(
        error?.response?.data?.error?.message
        || error?.response?.data?.error
        || error?.message
        || 'Failed to create tenant'
      );
    },
  });
}}
```

Disable form inputs during pending:
- Add `disabled={createMutation.isPending}` to each `<Input>` and `<Select>` inside the create dialog

- [ ] **Step 3: Add row feedback for suspend/activate**

Note: Row feedback (`opacity-60 pointer-events-none`) acts as a brief visual indicator. In Task 16, these mutations will be switched to optimistic hooks which update the cache instantly — at that point the row feedback becomes a very brief flash or invisible. It remains useful as a fallback pattern for non-optimistic mutations.

Add state for tracking mutating rows:
```tsx
const [mutatingRowIds, setMutatingRowIds] = useState<Set<string>>(new Set());
```

Add helper functions:
```tsx
const addMutatingRow = (id: string) =>
  setMutatingRowIds((prev) => new Set(prev).add(id));
const removeMutatingRow = (id: string) =>
  setMutatingRowIds((prev) => {
    const next = new Set(prev);
    next.delete(id);
    return next;
  });
```

For the suspend/activate buttons, wrap each mutation call:
```tsx
onClick={() => {
  addMutatingRow(tenant.id);
  suspendMutation.mutate(tenant.id, {
    onSettled: () => removeMutatingRow(tenant.id),
  });
}}
```

On each table row, add conditional styling:
```tsx
<tr
  key={tenant.id}
  className={cn(
    'border-t border-edge',
    mutatingRowIds.has(tenant.id) && 'opacity-60 pointer-events-none',
  )}
>
```

- [ ] **Step 4: Verify the page compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/admin/AdminTenants.tsx
git commit -m "feat(portal): add loading states, overlay, and row feedback to AdminTenants"
```

---

### Task 6: Apply Loading States to AdminUsers

**Files:**
- Modify: `portal/src/pages/admin/AdminUsers.tsx`

Reference: Currently uses `Loader2` centered spinner (line ~172-176). Has `AlertDialog` for promote/demote confirmation. `isMutating = promoteMutation.isPending || demoteMutation.isPending` used to disable buttons.

- [ ] **Step 1: Replace loading spinner with PageSkeleton**

Same pattern as Task 5 Step 1. Replace centered `Loader2` with `<PageSkeleton variant="table" rows={5} />`.

Add import: `import { PageSkeleton } from '@/components/ui/page-skeleton';`

- [ ] **Step 2: Add row-level feedback for promote/demote**

Add `mutatingRowIds` state + helpers (same pattern as Task 5 Step 3).

Wrap promote/demote mutation calls with `addMutatingRow`/`removeMutatingRow`.

Add conditional `opacity-60 pointer-events-none` to table rows.

- [ ] **Step 3: Add LoadingOverlay to confirm dialog**

Add imports for `LoadingOverlay`.

Inside the `AlertDialogContent`, add `relative` class and `<LoadingOverlay>`:
```tsx
<LoadingOverlay isLoading={promoteMutation.isPending || demoteMutation.isPending} />
```

- [ ] **Step 4: Verify**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/admin/AdminUsers.tsx
git commit -m "feat(portal): add loading states and row feedback to AdminUsers"
```

---

### Task 7: Apply Loading States to AdminTenantDetail

**Files:**
- Modify: `portal/src/pages/admin/AdminTenantDetail.tsx`

Reference: Currently uses centered `Loader2` spinner (line ~149-155). Has `AlertDialog` for API key rotation with a custom inline `rotateMutation`.

- [ ] **Step 1: Replace loading spinner with PageSkeleton**

Replace centered Loader2 block with `<PageSkeleton variant="list" rows={4} />`.

Add import: `import { PageSkeleton } from '@/components/ui/page-skeleton';`

- [ ] **Step 2: Add LoadingOverlay to API key rotation dialog**

Add import: `import { LoadingOverlay } from '@/components/ui/loading-overlay';`

Inside the API key rotation `AlertDialogContent`, add:
```tsx
<div className="relative">
  <LoadingOverlay isLoading={rotateMutation.isPending} message="Rotating API key..." />
  {/* existing dialog content */}
</div>
```

- [ ] **Step 3: Verify**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/admin/AdminTenantDetail.tsx
git commit -m "feat(portal): add loading states to AdminTenantDetail"
```

---

### Task 8: Apply PageSkeleton to AdminAuditLogs

**Files:**
- Modify: `portal/src/pages/admin/AdminAuditLogs.tsx`

- [ ] **Step 1: Replace loading spinner with PageSkeleton**

Find the loading state and replace with `<PageSkeleton variant="table" rows={8} />`.

Add import: `import { PageSkeleton } from '@/components/ui/page-skeleton';`

- [ ] **Step 2: Verify**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add portal/src/pages/admin/AdminAuditLogs.tsx
git commit -m "feat(portal): add PageSkeleton to AdminAuditLogs"
```

---

### Task 9: Apply Loading States to Team Page

**Files:**
- Modify: `portal/src/pages/Team.tsx`

Reference: Currently has custom hand-built skeleton (lines ~189-203 with `bg-surface-3` divs). OrgMembersPanel has its own inline skeleton (lines ~505-515). Has invite member form, agent modal (`Modal` component), role change selects, deactivate/reactivate buttons.

- [ ] **Step 1: Replace custom skeleton with PageSkeleton**

Replace the custom skeleton block (lines ~189-203) with:
```tsx
if (agentsLoading) {
  return <PageSkeleton variant="list" rows={6} />;
}
```

Replace the OrgMembersPanel inline skeleton with `<PageSkeleton variant="list" rows={4} />`.

Add import: `import { PageSkeleton } from '@/components/ui/page-skeleton';`

- [ ] **Step 2: Add LoadingOverlay + InlineError to invite member form**

Add imports:
```tsx
import { LoadingOverlay } from '@/components/ui/loading-overlay';
import { InlineError } from '@/components/ui/inline-error';
```

Add `inviteError` state. Wrap the invite form section in `relative` positioning. Add `<LoadingOverlay isLoading={inviteMutation.isPending} message="Sending invite..." />`. Add `<InlineError message={inviteError} />` below the form fields.

Update the invite mutation call to set `inviteError` on error and clear it on success.

- [ ] **Step 3: Add LoadingOverlay to AgentModal edit flow**

Pass an explicit `isSaving` prop from `Team.tsx` into `AgentModal` using `updateAgentMutation.isPending`.

Inside `AgentModal`, wrap the form in a `relative` container, add `<LoadingOverlay isLoading={isSaving && !!agent} message="Saving agent..." />`, disable form controls while pending, and prevent closing the modal from outside while saving.

Do not add create-agent loading state here. The current page does not create agents via an API mutation yet; it only edits existing agents.

- [ ] **Step 4: Add row feedback for role changes and deactivate/reactivate**

Add `mutatingRowIds` state + helpers.

For role change `<Select>` `onValueChange`:
```tsx
onValueChange={(value) => {
  addMutatingRow(member.id);
  updateRoleMutation.mutate(
    { userId: member.id, role: value },
    { onSettled: () => removeMutatingRow(member.id) },
  );
}}
```

Same pattern for deactivate/reactivate buttons.

Add conditional `opacity-60 pointer-events-none` to member rows and, if desired, agent table rows.

- [ ] **Step 5: Verify**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add portal/src/pages/Team.tsx
git commit -m "feat(portal): add loading states, overlays, and row feedback to Team page"
```

---

### Task 10: Apply PageSkeleton to Queue Page

**Files:**
- Modify: `portal/src/pages/Queue.tsx`

Reference: Currently uses a pure CSS spinner (`border-b-2 border-primary-600`, lines ~142-145). `useAcceptHandoff()` and `useRejectHandoff()` already optimistically remove items from the pending list in the query layer.

- [ ] **Step 1: Replace CSS spinner with PageSkeleton**

Replace the loading block with `<PageSkeleton variant="list" rows={5} />`.

Add import: `import { PageSkeleton } from '@/components/ui/page-skeleton';`

- [ ] **Step 2: Keep the existing optimistic removal behavior**

Do not add a second optimistic layer for Queue. The current handoff mutations already remove the item from the pending list immediately.

If additional feedback is still desired, limit it to button-level pending state:
- disable the clicked action button while its mutation is pending
- optionally render a small `Loader2` inside the button for the brief pre-removal window
- avoid row-level opacity treatment because the card is expected to disappear immediately

- [ ] **Step 3: Verify**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/Queue.tsx
git commit -m "feat(portal): add PageSkeleton and pending feedback to Queue page"
```

---

### Task 11: Apply PageSkeleton to LiveMonitor Page

**Files:**
- Modify: `portal/src/pages/LiveMonitor.tsx`

Reference: Currently has no loading state visible. Data may stream in via WebSocket.

- [ ] **Step 1: Add PageSkeleton for initial load (if applicable)**

Check whether the page has a data query with an `isLoading` state. If it does, wrap the main content:
```tsx
if (isLoading) {
  return <PageSkeleton variant="list" rows={6} />;
}
```

Add import: `import { PageSkeleton } from '@/components/ui/page-skeleton';`

If the page is purely WebSocket-driven with no initial query loading state, skip this task — note it as N/A and move on.

- [ ] **Step 2: Verify**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 3: Commit (if changes made)**

```bash
git add portal/src/pages/LiveMonitor.tsx
git commit -m "feat(portal): add PageSkeleton to LiveMonitor page"
```

---

### Task 12: Improve Save-State Feedback on Settings Page

**Files:**
- Modify: `portal/src/pages/Settings.tsx`

Reference: Currently has no loading skeleton. Uses manual `isSaving` state with inline CSS spinner divs (`border-b-2 border-white`). Has `handleSaveProfile`, `handleSaveNotifications`, `handleSaveAppearance`.

- [ ] **Step 1: Replace CSS spinner in save buttons with Loader2**

Replace the three instances of:
```tsx
<div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
```
with:
```tsx
<Loader2 className="w-4 h-4 animate-spin" />
```

This standardizes the spinner style across the app.

Add import if not present: `import { Loader2 } from 'lucide-react';`

- [ ] **Step 2: Disable all interactive controls during save**

For the active section, disable every interactive control while a save is in progress:
- `Input`
- `Switch`
- `Slider`
- theme selection buttons
- section save buttons

This prevents edits during submission, not just text input changes.

- [ ] **Step 3: Verify**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/Settings.tsx
git commit -m "feat(portal): standardize spinners and disable controls during save on Settings"
```

---

### Task 13: Wire Targeted Optimistic Mutations into Admin Queries

**Files:**
- Modify: `portal/src/queries/useAdminQueries.ts`

Reference: Currently exports `useSuspendTenant`, `useActivateTenant`, `usePromoteUser`, `useDemoteUser` as plain `useMutation` hooks. Add optimistic versions alongside them first, but make them operate on the real cached values: `queryKeys.admin.tenants()` and `queryKeys.admin.users()` currently store plain arrays, not `{ data: [...] }` envelopes.

- [ ] **Step 1: Add optimistic suspend/activate hooks**

Add new hooks after the existing ones:

```tsx
export function useOptimisticSuspendTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/tenants/${id}/suspend`),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.tenants() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.admin.tenants());
      queryClient.setQueryData<Any[]>(queryKeys.admin.tenants(), (prev = []) =>
        prev.map((t: any) => (t.id === id ? { ...t, status: 'suspended' } : t)),
      );
      return { previousData };
    },
    onError: (_error, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.admin.tenants(), context.previousData);
      }
      toast.error('Failed to suspend tenant');
    },
    onSuccess: () => toast.success('Tenant suspended'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants() });
    },
  });
}

export function useOptimisticActivateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/tenants/${id}/activate`),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.tenants() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.admin.tenants());
      queryClient.setQueryData<Any[]>(queryKeys.admin.tenants(), (prev = []) =>
        prev.map((t: any) => (t.id === id ? { ...t, status: 'active' } : t)),
      );
      return { previousData };
    },
    onError: (_error, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.admin.tenants(), context.previousData);
      }
      toast.error('Failed to activate tenant');
    },
    onSuccess: () => toast.success('Tenant activated'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants() });
    },
  });
}
```

- [ ] **Step 2: Add optimistic promote/demote hooks**

```tsx
export function useOptimisticPromoteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/promote`),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.users() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.admin.users());
      queryClient.setQueryData<Any[]>(queryKeys.admin.users(), (prev = []) =>
        prev.map((u: any) => (u.id === id ? { ...u, role: 'super_admin' } : u)),
      );
      return { previousData };
    },
    onError: (_error, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.admin.users(), context.previousData);
      }
      toast.error('Failed to promote user');
    },
    onSuccess: () => toast.success('User promoted to super admin'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
    },
  });
}

export function useOptimisticDemoteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/demote`),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.users() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.admin.users());
      queryClient.setQueryData<Any[]>(queryKeys.admin.users(), (prev = []) =>
        prev.map((u: any) => (u.id === id ? { ...u, role: 'admin' } : u)),
      );
      return { previousData };
    },
    onError: (_error, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.admin.users(), context.previousData);
      }
      toast.error('Failed to demote user');
    },
    onSuccess: () => toast.success('User demoted'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
    },
  });
}
```

- [ ] **Step 3: Verify**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add portal/src/queries/useAdminQueries.ts
git commit -m "feat(portal): add optimistic admin tenant and user mutations"
```

---

### Task 14: Wire Targeted Optimistic Mutations into Tenant Queries

**Files:**
- Modify: `portal/src/queries/useTenantQueries.ts`

Reference: Currently exports `useUpdateMemberRole`, `useDeactivateMember`, `useReactivateMember`. The members query caches a plain array, and the page currently identifies members by `member.id`, not `member.userId`.

- [ ] **Step 1: Add optimistic role change and deactivate/reactivate hooks**

Add hooks:

```tsx
export function useOptimisticUpdateMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api.patch(`/tenants/me/users/${userId}`, { role }),
    onMutate: async ({ userId, role }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tenants.members() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.tenants.members());
      queryClient.setQueryData<Any[]>(queryKeys.tenants.members(), (prev = []) =>
        prev.map((m: any) => (m.id === userId ? { ...m, role } : m)),
      );
      return { previousData };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.tenants.members(), context.previousData);
      }
      toast.error('Failed to update role');
    },
    onSuccess: () => toast.success('Role updated'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
    },
  });
}

export function useOptimisticDeactivateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.post(`/tenants/me/users/${userId}/deactivate`),
    onMutate: async (userId: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tenants.members() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.tenants.members());
      queryClient.setQueryData<Any[]>(queryKeys.tenants.members(), (prev = []) =>
        prev.map((m: any) => (m.id === userId ? { ...m, isActive: false } : m)),
      );
      return { previousData };
    },
    onError: (_error, _userId, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.tenants.members(), context.previousData);
      }
      toast.error('Failed to deactivate member');
    },
    onSuccess: () => toast.success('Member deactivated'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
    },
  });
}

export function useOptimisticReactivateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.post(`/tenants/me/users/${userId}/reactivate`),
    onMutate: async (userId: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tenants.members() });
      const previousData = queryClient.getQueryData<Any[]>(queryKeys.tenants.members());
      queryClient.setQueryData<Any[]>(queryKeys.tenants.members(), (prev = []) =>
        prev.map((m: any) => (m.id === userId ? { ...m, isActive: true } : m)),
      );
      return { previousData };
    },
    onError: (_error, _userId, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.tenants.members(), context.previousData);
      }
      toast.error('Failed to reactivate member');
    },
    onSuccess: () => toast.success('Member reactivated'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
    },
  });
}
```

- [ ] **Step 2: Verify**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add portal/src/queries/useTenantQueries.ts
git commit -m "feat(portal): add optimistic member role and status mutations"
```

---

### Task 15: Wire Targeted Optimistic Mutations into Agent Queries

**Files:**
- Modify: `portal/src/queries/useAgentQueries.ts`

Reference: Currently exports `useUpdateAgentStatus` which patches `/agents/${id}/status`. The optimistic version must update the exact list query key used by the page because agent lists are keyed by filters.

- [ ] **Step 1: Add optimistic agent status hook**

Add hook:

```tsx
export function useOptimisticUpdateAgentStatus(queryKey: QueryKey) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/agents/${id}/status`, { status }),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey });
      const previousData = queryClient.getQueryData<Any[]>(queryKey);
      queryClient.setQueryData<Any[]>(queryKey, (prev = []) =>
        prev.map((a: any) => (a.id === id ? { ...a, status } : a)),
      );
      return { previousData };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKey, context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.all() });
    },
  });
}
```

- [ ] **Step 2: Verify**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add portal/src/queries/useAgentQueries.ts
git commit -m "feat(portal): add optimistic agent status mutation"
```

---

### Task 16: Switch Pages to Optimistic Hooks

**Files:**
- Modify: `portal/src/pages/admin/AdminTenants.tsx`
- Modify: `portal/src/pages/admin/AdminUsers.tsx`
- Modify: `portal/src/pages/admin/AdminTenantDetail.tsx`
- Modify: `portal/src/pages/Team.tsx`

- [ ] **Step 1: Switch AdminTenants to optimistic suspend/activate**

Replace:
```tsx
const suspendMutation = useSuspendTenant();
const activateMutation = useActivateTenant();
```
With:
```tsx
const suspendMutation = useOptimisticSuspendTenant();
const activateMutation = useOptimisticActivateTenant();
```

Update imports accordingly. The mutation API (`mutate`, `isPending`) is identical so no other changes needed.

- [ ] **Step 2: Switch AdminUsers to optimistic promote/demote**

Same pattern — replace `usePromoteUser()` / `useDemoteUser()` with `useOptimisticPromoteUser()` / `useOptimisticDemoteUser()`.

- [ ] **Step 3: Switch Team to optimistic role/status hooks**

Replace `useUpdateMemberRole()` with `useOptimisticUpdateMemberRole()`.
Replace `useDeactivateMember()` / `useReactivateMember()` with optimistic versions.
Replace `useUpdateAgentStatus()` with `useOptimisticUpdateAgentStatus(queryKeys.agents.list(undefined))`.

Note: keep the member mutation variables aligned with the real page shape: `member.id` is the identifier currently used in `Team.tsx`.

- [ ] **Step 4: Switch AdminTenantDetail before removing old admin hooks**

Replace the page's `useSuspendTenant()` / `useActivateTenant()` imports with the optimistic admin variants too. This page still depends on those hooks today, so do not remove the legacy hooks until this page is migrated.

- [ ] **Step 5: Verify all four pages compile**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 6: Remove old non-optimistic hooks**

After all pages are switched and a repo-wide search confirms there are no remaining imports, remove the now-unused hooks from the query files:
- `useAdminQueries.ts`: remove `useSuspendTenant`, `useActivateTenant`, `usePromoteUser`, `useDemoteUser`
- `useTenantQueries.ts`: remove `useUpdateMemberRole`, `useDeactivateMember`, `useReactivateMember`
- `useAgentQueries.ts`: remove `useUpdateAgentStatus`

Verify no other files import them first (search for the hook names across the portal).

- [ ] **Step 7: Commit**

```bash
git add portal/src/pages/admin/AdminTenants.tsx portal/src/pages/admin/AdminUsers.tsx portal/src/pages/admin/AdminTenantDetail.tsx portal/src/pages/Team.tsx portal/src/queries/useAdminQueries.ts portal/src/queries/useTenantQueries.ts portal/src/queries/useAgentQueries.ts
git commit -m "feat(portal): switch pages to optimistic hooks and remove old mutation hooks"
```

---

### Task 17: Apply LoadingOverlay to Tenants Page

**Files:**
- Modify: `portal/src/pages/Tenants.tsx`

Reference: This is the tenant settings page (not admin). Check if it has dialogs/modals for updating tenant settings.

- [ ] **Step 1: Add LoadingOverlay to any settings dialogs**

Add import:
```tsx
import { LoadingOverlay } from '@/components/ui/loading-overlay';
```

Find any mutation-submitting dialogs (e.g., tenant settings update). Wrap dialog content in `relative` div and add `<LoadingOverlay>` tied to the mutation's `isPending`.

If the page has no dialogs/modals (settings are inline), add disabled/pending state to every interactive control and ensure save buttons show spinners. Use the same pattern as Settings page (Task 12).

- [ ] **Step 2: Verify**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add portal/src/pages/Tenants.tsx
git commit -m "feat(portal): add loading feedback to Tenants settings page"
```

---

### Task 18: Final Verification

- [ ] **Step 1: Run full type check**

Run: `cd chatbot-platform/portal && npx tsc --noEmit --pretty`
Expected: No type errors

- [ ] **Step 2: Run dev server and smoke test**

Run: `cd chatbot-platform/portal && npm run dev`

Manual checks:
1. Navigate to each admin page — should see table skeletons on load, not spinners
2. Open create tenant dialog — submit with valid data, confirm overlay appears
3. Try suspend/activate — should update instantly (optimistic)
4. Check Team page — invite member shows overlay, role change is instant
5. Check Queue page — should see list skeleton on load
6. Check Settings page — save buttons show Loader2 spinner, inputs disabled during save

- [ ] **Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "fix(portal): final loading state adjustments from smoke testing"
```
