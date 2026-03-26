# Super Admin Hard Delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add permanent user deletion for super admins on `/admin/users` so an already-deactivated user can be anonymized, soft-deleted, removed from Clerk org membership, and disappear from both admin and tenant member views.

**Architecture:** Add a new `DELETE /admin/users/:id` route in `admin.routes.ts`, keep the destructive DB work inside one transaction, and perform Clerk cleanup after commit. Because this codebase stores `deletedAt` but does not auto-filter soft-deleted rows, update the affected admin and tenant user queries to exclude deleted users explicitly. On the frontend, extend the existing `AdminUsers` promote/demote flow with a delete mutation and destructive confirmation dialog.

**Tech Stack:** TypeORM, Express, React, TanStack Query, shadcn AlertDialog, Clerk SDK

---

## Review Notes

- The original draft only touched three files, but that would leave soft-deleted users visible in existing list/detail routes.
- The original draft used `undefined` to clear nullable columns in TypeORM updates. That is unsafe here: use `NULL`/`null`, not `undefined`, when clearing `clerkUserId`, `avatarUrl`, or `assignedAgentId`.
- No migration is required. `deleted_at` already exists on `users` and `agents`.
- Avoid brittle line-number instructions. This plan is organized by route/function instead.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `api/src/routes/admin.routes.ts` | Modify | Add hard-delete endpoint and exclude soft-deleted users from admin user routes |
| `api/src/routes/tenants.ts` | Modify | Exclude soft-deleted users from tenant member list and member mutation routes |
| `portal/src/queries/useAdminQueries.ts` | Modify | Add `useDeleteUser()` mutation hook |
| `portal/src/pages/admin/AdminUsers.tsx` | Modify | Add delete action, dialog copy, and row loading state |

---

## Task 1: Backend — Add `DELETE /admin/users/:id`

**Files:**
- Modify: `api/src/routes/admin.routes.ts`

- [ ] **Step 1: Add the missing imports and soft-delete helpers**

Update `admin.routes.ts` imports so the file can implement the delete flow cleanly:

- Add `Agent` and `HandoffRequest` entity imports.
- Add `IsNull` from `typeorm` for explicit soft-delete filtering.
- Reuse existing imports already present in the file: `ChatSession`, `PendingInvite`, `Tenant`, `removeFromClerkOrganization`, `invalidateProvisionCache`, `logAudit`, `logger`.

- [ ] **Step 2: Exclude soft-deleted users from existing admin user routes**

Before adding the new delete route, tighten the existing admin user routes so deleted users stop appearing or being mutated:

- `GET /admin/users`: add `user.deletedAt IS NULL` to the query builder.
- `GET /admin/users/:id`: fetch by `{ id, deletedAt: IsNull() }`.
- `PATCH /admin/users/:id`: fetch by `{ id, deletedAt: IsNull() }`.
- `POST /admin/users/:id/reactivate`: fetch by `{ id, deletedAt: IsNull() }`.
- `POST /admin/users/:id/promote`: fetch by `{ id, deletedAt: IsNull() }`.
- `POST /admin/users/:id/demote`: fetch by `{ id, deletedAt: IsNull() }`.
- Any super-admin counts used for safety checks should count only undeleted users.

This prevents a soft-deleted user from reappearing in `/admin/users` or being mutated by stale IDs.

- [ ] **Step 3: Add `DELETE /admin/users/:id` after the demote route**

Implement a new route with these semantics:

1. Load the target user with `deletedAt: IsNull()`.
2. Validate:
   - user exists
   - user is already deactivated (`isActive === false`)
   - target user is not `req.userId`
   - deleting this user would not remove the last undeleted `super_admin`
3. Capture the data needed after commit:
   - `clerkUserId`
   - `tenantId`
   - tenant record if `clerkOrgId` is needed for Clerk cleanup/cache invalidation
4. Load the undeleted agent profile for this user, if one exists.
5. Run one DB transaction that:
   - anonymizes the user record
   - soft-deletes the user (`deletedAt = now`)
   - soft-deletes the linked agent profile, if present
   - clears `assigned_agent_id` on `chat_sessions` for that agent
   - clears `assigned_agent_id` on `handoff_requests` for that agent
   - deletes pending invites where `invitedBy = userId`
6. After commit:
   - remove the user from the Clerk org if both `clerkOrgId` and `clerkUserId` exist
   - invalidate the auto-provision cache for that Clerk membership
   - write `user.deleted` audit log
   - return `sendSuccess(res, { deleted: true })`

Implementation constraints:

- When clearing nullable DB fields, do not rely on `undefined`.
- Use `NULL`/`null` for:
  - `users.avatar_url`
  - `users.clerk_user_id`
  - `chat_sessions.assigned_agent_id`
  - `handoff_requests.assigned_agent_id`
- Keep Clerk removal outside the transaction so external failure does not roll back the DB change.
- Log Clerk cleanup failure as a warning, not a hard failure.

Suggested anonymized values:

- `name = 'Deleted User'`
- `email = deleted_${user.id}@removed.local`
- `avatarUrl = NULL`
- `clerkUserId = NULL`

- [ ] **Step 4: Verify the API compiles**

```bash
cd api && npx tsc --noEmit
```

Expected: no TypeScript errors.

- [ ] **Step 5: Backend smoke test**

Using a deactivated user in a non-production environment:

1. Call `DELETE /api/v1/admin/users/:id`.
2. Confirm response body is `{ success: true, data: { deleted: true } }`.
3. Confirm the user row now has anonymized fields and `deleted_at` set.
4. Confirm the user no longer appears in `GET /api/v1/admin/users`.
5. Confirm any linked agent is soft-deleted and assigned sessions/handoffs are unassigned.

---

## Task 2: Backend — Hide Deleted Users from Tenant Member Flows

**Files:**
- Modify: `api/src/routes/tenants.ts`

- [ ] **Step 1: Exclude soft-deleted users from the tenant members list**

Update `GET /api/v1/tenants/me/users` so the query builder includes `user.deletedAt IS NULL`.

Without this, a hard-deleted user would still appear on the tenant Team page.

- [ ] **Step 2: Guard tenant member mutation routes**

Update tenant member routes to fetch only undeleted users:

- `PATCH /api/v1/tenants/me/users/:userId`
- `POST /api/v1/tenants/me/users/:userId/deactivate`
- `POST /api/v1/tenants/me/users/:userId/reactivate`

Use `{ id: req.params.userId, tenantId, deletedAt: IsNull() }` or the equivalent query-builder filter.

Also update any admin-count safety query in these routes to ignore deleted rows.

This prevents tenant admins from changing the role or activation state of a soft-deleted member.

- [ ] **Step 3: Re-run API compile check**

```bash
cd api && npx tsc --noEmit
```

Expected: still clean.

---

## Task 3: Frontend — Add Delete Mutation Hook

**Files:**
- Modify: `portal/src/queries/useAdminQueries.ts`

- [ ] **Step 1: Add `useDeleteUser()`**

Add a mutation hook alongside the existing optimistic admin user mutations:

- `mutationFn`: `api.delete(`/admin/users/${id}`)`
- `onMutate`:
  - cancel `queryKeys.admin.users()`
  - snapshot previous list
  - optimistically remove the deleted row from the cached user list
- `onError`:
  - restore previous list
  - show `toast.error('Failed to delete user')`
- `onSuccess`:
  - show `toast.success('User permanently deleted')`
- `onSettled`:
  - invalidate `queryKeys.admin.users()`

Keep this hook consistent with the existing optimistic promote/demote hooks.

- [ ] **Step 2: Verify portal compile**

```bash
cd portal && npx tsc --noEmit
```

Expected: no TypeScript errors.

---

## Task 4: Frontend — Add Delete UI to `AdminUsers`

**Files:**
- Modify: `portal/src/pages/admin/AdminUsers.tsx`

- [ ] **Step 1: Extend imports and local action types**

Update the page to support a third confirmation action:

- Add `Trash2` to the lucide import.
- Import `useDeleteUser`.
- Expand `ConfirmAction` to include `'delete'`.

- [ ] **Step 2: Wire the delete mutation into the existing row-state pattern**

Follow the same shape already used for promote/demote:

- create `const deleteMutation = useDeleteUser()`
- include `deleteMutation.isPending` in `isMutating`
- update `handleConfirm()` so:
  - delete uses `deleteMutation`
  - promote/demote keep their current behavior
  - all branches still add/remove the row ID from `mutatingRowIds`
  - all branches close the dialog in `onSettled`

- [ ] **Step 3: Add the delete button in the actions column**

Update the actions cell so:

- promote/demote stays exactly as it works now
- a destructive "Delete" button appears only when `user.isActive === false`
- the delete button sets `confirmAction` to `{ type: 'delete', user }`

Layout note:

- keep promote/demote and delete in a small right-aligned button row so the table layout does not jump

- [ ] **Step 4: Extend the AlertDialog copy and styling**

Update the shared confirmation dialog so it handles all three actions:

- Title:
  - promote: `Promote to Super Admin`
  - demote: `Demote from Super Admin`
  - delete: `Permanently Delete User`
- Description for delete:
  - explain that the action anonymizes the user and cannot be undone
- Confirm button label:
  - promote: `Promote`
  - demote: `Demote`
  - delete: `Delete Permanently`
- Confirm button styling:
  - keep current accent/busy styles for promote/demote
  - use destructive styling for delete

Use existing shadcn/button utility styles instead of inventing a new one-off color scheme.

- [ ] **Step 5: Manual portal smoke test**

1. Open `/admin/users`.
2. Confirm active users do not show the delete button.
3. Confirm inactive users do show the delete button.
4. Open the dialog and confirm the delete copy is distinct from promote/demote.
5. Confirm deleting a user removes the row immediately.
6. Refresh the page and confirm the deleted user stays gone.

- [ ] **Step 6: Verify portal compile again**

```bash
cd portal && npx tsc --noEmit
```

Expected: still clean.

---

## Task 5: Final Verification

- [ ] **Step 1: End-to-end behavior check**

Verify the full flow on a test user with an agent profile:

1. Deactivate the user first.
2. Delete the user from `/admin/users`.
3. Confirm:
   - the user disappears from `/admin/users`
   - the user disappears from tenant `/team` or equivalent member list
   - the user cannot be reactivated or role-edited through stale tenant/admin routes
   - linked sessions/handoffs are unassigned
   - Clerk org membership removal failure, if any, is logged but does not undo the DB deletion

- [ ] **Step 2: Commit**

```bash
git add api/src/routes/admin.routes.ts api/src/routes/tenants.ts portal/src/queries/useAdminQueries.ts portal/src/pages/admin/AdminUsers.tsx docs/superpowers/plans/2026-03-27-super-admin-hard-delete-plan.md
git commit -m "docs: correct super admin hard delete implementation plan"
```
