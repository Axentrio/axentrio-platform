# Admin Users Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix security gaps, audit logging, and dead code from the admin users feature and accent color removal.

**Architecture:** Add a dedicated deactivate endpoint mirroring the existing reactivate pattern, with self-deactivation guard and audit logging. Remove `isActive` from the generic PATCH handler to prevent drift. Clean up all orphaned accent color code including the `index.html` first-paint script. Extract confirm dialog config to a lookup map for readability. Add integration tests for the new endpoint.

**Tech Stack:** TypeScript, Express, TypeORM, React, TanStack Query, Vitest, Supertest

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `api/src/routes/admin.routes.ts` | Add dedicated deactivate endpoint, remove `isActive` from PATCH, add self-guard and audit log |
| Modify | `api/src/__tests__/integration/admin.test.ts` | Add tests for new deactivate endpoint |
| Modify | `portal/src/queries/useAdminQueries.ts` | Update deactivate mutation to use new dedicated endpoint |
| Modify | `portal/src/contexts/ThemeContext.tsx` | Remove dead accent color state and `setOrgAccent` |
| Modify | `portal/src/hooks/useTenantTheme.ts` | Remove stale comment and `setOrgAccent` effect |
| Modify | `portal/src/config/constants.ts` | Remove unused ACCENT storage key |
| Modify | `portal/src/pages/settings/AppearanceSettings.tsx` | Update stale file header comment |
| Modify | `portal/index.html` | Remove stale accent color first-paint script |
| Modify | `portal/src/pages/admin/AdminUsers.tsx` | Extract confirm dialog config to a lookup map |

---

### Task 1: Add dedicated deactivate endpoint with self-guard and audit log

**Files:**
- Modify: `api/src/routes/admin.routes.ts`

- [ ] **Step 1: Add `POST /admin/users/:id/deactivate` endpoint adjacent to the reactivate handler (before line 517)**

Place it right before the reactivate endpoint so activate/deactivate routes are grouped together.

```typescript
// POST /admin/users/:id/deactivate — deactivate a user
router.post('/users/:id/deactivate', asyncHandler(async (req: Request, res: Response) => {
  const userRepo = AppDataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { id: req.params.id, deletedAt: IsNull() } });

  if (!user) throw new NotFoundError('User not found');
  if (!user.isActive) throw new BadRequestError('User is already inactive');
  if (req.params.id === req.userId) throw new BadRequestError('Cannot deactivate yourself');

  user.isActive = false;

  // Remove from Clerk org if applicable
  if (user.clerkUserId) {
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: user.tenantId },
    });
    if (tenant?.clerkOrgId) {
      const removed = await removeFromClerkOrganization(tenant.clerkOrgId, user.clerkUserId);
      if (!removed) {
        logger.warn('Failed to remove user from Clerk org — deactivated locally only', {
          userId: user.id, tenantId: tenant.id,
        });
      }
    }
  }

  await userRepo.save(user);
  await logAudit(req.userId!, 'user.deactivated', 'user', user.id, user.tenantId);

  // Invalidate cache so changes take effect immediately
  if (user.clerkUserId) {
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: user.tenantId } });
    if (tenant?.clerkOrgId) {
      invalidateProvisionCache(tenant.clerkOrgId, user.clerkUserId);
    }
  }

  logger.info('Deactivated user', { userId: user.id, deactivatedBy: req.userId });
  sendSuccess(res, user);
}));
```

- [ ] **Step 2: Remove `isActive` handling from the generic PATCH handler**

In the existing `PATCH /users/:id` handler (line 425-471), remove the entire `isActive` block (lines 437-453) so that `isActive` changes can only go through the dedicated deactivate/reactivate endpoints. The PATCH handler should only handle `role` changes.

Remove this block:

```typescript
  if (typeof isActive === 'boolean') {
    user.isActive = isActive;

    // If deactivating and user has Clerk ID, remove from Clerk org
    if (!isActive && user.clerkUserId) {
      const tenant = await AppDataSource.getRepository(Tenant).findOne({
        where: { id: user.tenantId },
      });
      if (tenant?.clerkOrgId) {
        const removed = await removeFromClerkOrganization(tenant.clerkOrgId, user.clerkUserId);
        if (!removed) {
          logger.warn('Failed to remove user from Clerk org — deactivated locally only', {
            userId: user.id, tenantId: tenant.id,
          });
        }
      }
    }
  }
```

Also remove `isActive` from the destructuring on line 432:

```typescript
// Before:
  const { role, isActive } = req.body;

// After:
  const { role } = req.body;
```

- [ ] **Step 3: Verify the API compiles**

Run: `cd api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/admin.routes.ts
git commit -m "fix(api): add dedicated deactivate endpoint, remove isActive from generic PATCH"
```

---

### Task 2: Add integration tests for the deactivate endpoint

**Files:**
- Modify: `api/src/__tests__/integration/admin.test.ts`

- [ ] **Step 1: Add auth-rejection tests for the new deactivate endpoint**

Append to the existing `describe('Admin Routes')` block in `api/src/__tests__/integration/admin.test.ts`:

```typescript
  describe('POST /api/v1/admin/users/:id/deactivate', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).post(
        '/api/v1/admin/users/00000000-0000-0000-0000-000000000000/deactivate',
      );
      expect(res.status).toBe(401);
    });
  });
```

- [ ] **Step 2: Run the tests**

Run: `cd api && npx vitest run src/__tests__/integration/admin.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/admin.test.ts
git commit -m "test(api): add auth-rejection test for deactivate endpoint"
```

---

### Task 3: Update frontend mutation to use dedicated deactivate endpoint

**Files:**
- Modify: `portal/src/queries/useAdminQueries.ts`

- [ ] **Step 1: Change `useOptimisticDeactivateUser` from PATCH to POST**

In `portal/src/queries/useAdminQueries.ts`, find the `useOptimisticDeactivateUser` function and change:

```typescript
// Before:
mutationFn: (id: string) => api.patch(`/admin/users/${id}`, { isActive: false }),

// After:
mutationFn: (id: string) => api.post(`/admin/users/${id}/deactivate`),
```

- [ ] **Step 2: Verify the portal compiles**

Run: `cd portal && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add portal/src/queries/useAdminQueries.ts
git commit -m "refactor(portal): use dedicated deactivate endpoint instead of generic PATCH"
```

---

### Task 4: Clean up orphaned accent color code

**Files:**
- Modify: `portal/src/contexts/ThemeContext.tsx`
- Modify: `portal/src/hooks/useTenantTheme.ts`
- Modify: `portal/src/config/constants.ts`
- Modify: `portal/src/pages/settings/AppearanceSettings.tsx`
- Modify: `portal/index.html`

- [ ] **Step 1: Simplify ThemeContext — remove all accent state**

Replace the full content of `portal/src/contexts/ThemeContext.tsx` with:

```typescript
/**
 * Theme Context
 * Manages light/dark/system theme.
 * Applies .dark class on <html>, persists to localStorage.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { STORAGE_KEYS } from '@/config/constants';

type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: ThemeMode) => void;
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
  if (resolved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.THEME);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    return 'system';
  });

  const resolved = resolveTheme(theme);

  useEffect(() => {
    applyThemeClass(resolved);
  }, [resolved]);

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

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme: resolved, setTheme }}>
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

- [ ] **Step 2: Remove `setOrgAccent` effect from useTenantTheme.ts**

In `portal/src/hooks/useTenantTheme.ts`:

Remove the import of `useTheme`:
```typescript
// Remove this line:
import { useTheme } from '@/contexts/ThemeContext';
```

Remove the `setOrgAccent` usage (lines 79, 87-89):
```typescript
// Remove:
  const { setOrgAccent } = useTheme();

// Remove:
  useEffect(() => {
    setOrgAccent(hasOrgBranding ? rawColor : null);
  }, [hasOrgBranding, rawColor, setOrgAccent]);
```

Update the stale export comment at line 69:
```typescript
// Before:
/** Exported for reuse by accent color picker */

// After:
/** Exported for reuse by theme utilities */
```

- [ ] **Step 3: Fix any consumers that destructure removed fields**

In `portal/src/pages/settings/AppearanceSettings.tsx`, verify the import only uses `theme` and `setTheme`:

```typescript
const { theme, setTheme } = useTheme();
```

Update the stale file header at line 3:
```typescript
// Before:
 * Theme switcher with mini previews and accent color picker

// After:
 * Theme switcher with mini previews
```

- [ ] **Step 4: Remove unused ACCENT storage key**

In `portal/src/config/constants.ts`, remove the `ACCENT` line from `STORAGE_KEYS`:

```typescript
// Remove this line:
  ACCENT: 'handsoff_accent',
```

- [ ] **Step 5: Clean up index.html first-paint script**

In `portal/index.html`, remove the accent color lines from the inline script (lines 17-18). The script should only handle dark mode:

```html
    <script>
      (function() {
        var t = localStorage.getItem('handsoff_theme') || 'system';
        var d = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        if (d) document.documentElement.classList.add('dark');
      })();
    </script>
```

This removes the stale `handsoff_accent` localStorage read that could override brand colors on first paint.

- [ ] **Step 6: Verify the portal compiles**

Run: `cd portal && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add portal/src/contexts/ThemeContext.tsx portal/src/hooks/useTenantTheme.ts portal/src/config/constants.ts portal/src/pages/settings/AppearanceSettings.tsx portal/index.html
git commit -m "chore(portal): remove all orphaned accent color code"
```

---

### Task 5: Extract confirm dialog config to a lookup map

**Files:**
- Modify: `portal/src/pages/admin/AdminUsers.tsx`

- [ ] **Step 1: Add a config map above the component (after the helpers section)**

```typescript
const confirmDialogConfig: Record<
  'promote' | 'demote' | 'deactivate' | 'reactivate' | 'delete',
  { title: string; buttonLabel: string; buttonClass: string }
> = {
  promote: {
    title: 'Promote to Super Admin',
    buttonLabel: 'Promote',
    buttonClass: 'bg-accent-500 hover:bg-accent-600',
  },
  demote: {
    title: 'Demote from Super Admin',
    buttonLabel: 'Demote',
    buttonClass: 'bg-status-busy hover:bg-status-busy/90',
  },
  deactivate: {
    title: 'Deactivate User',
    buttonLabel: 'Deactivate',
    buttonClass: 'bg-yellow-600 hover:bg-yellow-700',
  },
  reactivate: {
    title: 'Reactivate User',
    buttonLabel: 'Reactivate',
    buttonClass: 'bg-green-600 hover:bg-green-700',
  },
  delete: {
    title: 'Permanently Delete User',
    buttonLabel: 'Delete Permanently',
    buttonClass: 'bg-red-600 hover:bg-red-700',
  },
};
```

- [ ] **Step 2: Replace the ternary chains in the dialog with config lookups**

Replace the `AlertDialogTitle` ternary with:
```tsx
<AlertDialogTitle>
  {confirmAction && confirmDialogConfig[confirmAction.type].title}
</AlertDialogTitle>
```

Replace the `AlertDialogAction` className ternary with:
```tsx
className={confirmAction ? confirmDialogConfig[confirmAction.type].buttonClass : ''}
```

Replace the button label ternary with:
```tsx
{isMutating ? (
  <Loader2 className="w-4 h-4 animate-spin" />
) : confirmAction ? confirmDialogConfig[confirmAction.type].buttonLabel : ''}
```

Keep the `AlertDialogDescription` as-is — the descriptions contain dynamic JSX with user names and can't be easily extracted to a static config.

- [ ] **Step 3: Verify the portal compiles**

Run: `cd portal && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/admin/AdminUsers.tsx
git commit -m "refactor(portal): extract confirm dialog config to lookup map in AdminUsers"
```

---

## Caveats / Out of Scope

- **`isMutating` global scope**: All action buttons disable when any mutation is pending. Conservative but not harmful. Could be narrowed to per-row in a future pass.
- **Email-based "You" matching**: Works correctly with the `tenantId` guard but is theoretically fragile if emails change mid-session. A proper fix would require the backend to return the current user's database user ID (not agent ID) in the admin users response. Tracked as a future improvement.
- **Integration tests are auth-rejection only**: The existing test infrastructure uses `supertest` against the Express app without authenticated sessions. Adding full CRUD tests with mocked auth would require setting up test fixtures and auth helpers, which is out of scope for this hardening pass.
