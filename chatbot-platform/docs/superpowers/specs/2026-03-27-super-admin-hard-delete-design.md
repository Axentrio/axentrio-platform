# Super Admin Hard Delete — Design Spec

## Overview

Add permanent user deletion for super admins on `/admin/users`. Users must be deactivated first. Deletion anonymizes PII, soft-deletes DB records, nulls out agent assignments, and removes from Clerk org.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Chat history | Anonymize (keep messages, replace name) | Preserves conversation history for audit/analytics |
| Clerk handling | Remove from org only (not full Clerk delete) | Multi-tenant — user could join another org |
| Safety gate | Deactivate first, then delete | Two-step prevents accidental deletion of active users |
| Deletion strategy | Anonymize + soft delete (Approach A) | Preserves FK integrity, matches existing soft-delete pattern |

## API

### `DELETE /admin/users/:id`

**Auth:** `requireClerkAuth`, `autoProvision`, `requireSuperAdmin`

**Validation:**
- User must exist
- User must be deactivated (`isActive === false`)
- Cannot delete yourself
- Cannot delete last super admin

**Transaction (single DB transaction):**
1. Anonymize User record:
   - `name` → `"Deleted User"`
   - `email` → `deleted_{user.id}@removed.local`
   - `avatarUrl` → `null`
   - `clerkUserId` → `null`
2. Soft-delete User: `deletedAt = now()`
3. Soft-delete Agent profile (if exists): `deletedAt = now()`
4. Null out `assigned_agent_id` on ChatSessions referencing this agent
5. Null out `assigned_agent_id` on HandoffRequests referencing this agent
6. Delete PendingInvites where `invited_by = userId`

**Post-transaction (non-blocking):**
- Remove from Clerk org via `removeFromClerkOrganization()`
- Log audit event: `user.deleted`

**Response:** `{ success: true, data: { deleted: true } }`

**Error responses:**
- 400: "User must be deactivated before deletion"
- 400: "Cannot delete yourself"
- 400: "Cannot delete the last super admin"
- 404: "User not found"

## Frontend

### AdminUsers page (`/admin/users`)

**New UI elements:**
- "Delete" button (trash icon, red/destructive styling) in actions column
- Only visible when `user.isActive === false`
- Opens AlertDialog:
  - Title: "Permanently Delete User"
  - Description: "This will anonymize {name}'s data and remove them permanently. This cannot be undone."
  - Actions: Cancel + "Delete Permanently" (destructive variant)

**New query hook:** `useDeleteUser()` in `useAdminQueries.ts`
- Calls `DELETE /admin/users/:id`
- Invalidates admin users query on success
- Toast: success ("User permanently deleted") / error

**Behavior:**
- Optimistic row tracking via existing `mutatingRowIds` pattern
- Row shows loading state during deletion
- Row removed from table on success

### No changes to `/team`
Org admins keep existing deactivate/reactivate flow. Hard delete is super-admin-only.

## Data Impact

| Entity | Action |
|--------|--------|
| User | Anonymize PII + soft delete |
| Agent | Soft delete |
| ChatSession | Null `assigned_agent_id` |
| HandoffRequest | Null `assigned_agent_id` |
| PendingInvite | Hard delete where `invited_by = userId` |
| Message | No change (preserved, author shown as "Deleted User") |
| AuditLog | No change (actorId preserved, name resolved at query time) |

## Edge Cases

- **Last super admin:** Blocked — returns 400
- **Self-deletion:** Blocked — returns 400
- **Clerk sync failure:** Logged as warning, does not roll back DB transaction
- **User already soft-deleted:** Returns 404 (queries should exclude soft-deleted)
- **Agent has active sessions:** Sessions become unassigned (nulled), not deleted
