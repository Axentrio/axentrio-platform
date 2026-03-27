# Phase 1 Gap-Closing Spec

> Close out the remaining gaps in Phase 1 (Finish Admin Gaps) before moving to Phase 2.

---

## 1. Session Cleanup on Member Deactivation

### Problem

When a member is deactivated, their assigned chat sessions and accepted handoff requests are not cleaned up. This orphans conversations. User deletion (`DELETE /admin/users/:id`) nulls out `assignedAgentId` on `ChatSession` and `HandoffRequest` inside a transaction, but does not change session status or emit socket events. Deactivation does neither.

### Design

Extract a shared helper `releaseAgentSessions` used by both deactivation and deletion.

**Signature:**

```typescript
async function releaseAgentSessions(
  agentId: string,
  tenantId: string,
  manager: EntityManager  // runs inside caller's transaction
): Promise<{ releasedSessions: number; returnedHandoffs: number }>
```

**Steps (all within the caller's transaction):**

1. Resolve the `Agent` entity from the `userId` passed to the deactivation endpoint. If no agent exists for this user, skip cleanup (user may be admin-only with no agent record).
2. Query all `ChatSession` rows where `assignedAgentId = agent.id` and status in (`active`, `handoff`). Set `assignedAgentId = null` and status to `waiting`.
3. Query all `HandoffRequest` rows where `assignedAgentId = agent.id` and status is `accepted`. Set `assignedAgentId = null` and status to `requested`.
4. Return counts of affected rows.

**Socket events (emitted after transaction commits, not inside it):**

- Per affected session: `emitToSession(tenantId, sessionId, 'agent:removed', { sessionId, reason: 'agent_deactivated' })` — the widget should handle this by showing a "you've been reconnected to the queue" message.
- Once to agent room: `emitToTenantAgents(tenantId, 'handoff:queue_updated', { reason: 'agent_deactivated' })` — triggers queue refresh for other agents.

**Audit log metadata** includes `{ releasedSessions, returnedHandoffs }`.

### Affected Endpoints

- `POST /admin/users/:id/deactivate` (admin.routes.ts) — add helper call + socket emits after Clerk removal.
- `POST /tenants/me/users/:userId/deactivate` (tenants.ts) — same.
- `DELETE /admin/users/:id` (admin.routes.ts) — refactor existing inline cleanup to use the same helper within its existing transaction.

### Helper Location

`api/src/utils/releaseAgentSessions.ts`

---

## 2. Super-Admin Invite Resend/Cancel

### Problem

Super-admins can list pending invites on `AdminTenantDetail` but cannot resend or cancel them. No API endpoints exist at the super-admin level for these actions.

### Design

**API — two new endpoints in `admin.routes.ts`:**

- `POST /admin/tenants/:id/pending-invites/:inviteId/resend`
  - Looks up `PendingInvite` by ID scoped to tenant ID. 404 if not found.
  - Looks up the tenant's `clerkOrgId` to pass to Clerk.
  - Re-sends via `inviteToClerkOrganization(clerkOrgId, invite.email)` (the existing wrapper in `clerk-sync.service.ts`).
  - Resets `expiresAt` to 7 days from now.
  - Logs `invite.resent` audit event.
  - Returns updated invite.

- `DELETE /admin/tenants/:id/pending-invites/:inviteId`
  - Looks up `PendingInvite` by ID scoped to tenant ID. 404 if not found.
  - Deletes the record.
  - Logs `invite.cancelled` audit event.
  - Returns 204.

Both use the existing `requireSuperAdmin` middleware.

**Portal — `AdminTenantDetail.tsx`:**

- Add Resend (rotate icon) and Cancel (X icon) buttons to each invite row, matching the existing pattern in `Team.tsx`.
- Two new mutation hooks in `useAdminQueries.ts`: `useAdminResendInvite(tenantId)` and `useAdminCancelInvite(tenantId)`.
- On success, invalidate both `queryKeys.admin.tenantDetail(id)` and `queryKeys.admin.tenantAudit(id)` so the invite list and recent activity section both refresh.

---

## 3. Audit Log Viewer Improvements

### Problem

The API supports filtering by tenant, action, and date range plus CSV export, but the portal UI only has a client-side text search and tenant dropdown. No export button, no pagination. Additional issues: the API doesn't return `tenantName` (the portal expects it and falls back to "—"), the apiClient response interceptor drops pagination metadata, and the tenant dropdown is capped at 20 results.

### 3a. Backend: Resolve Tenant Names

Join the `Tenant` entity in `GET /admin/audit-logs` to include `tenantName` in each log entry. Add `tenant_name` column to the CSV export output.

### 3b. Backend: Fix Date Range End-of-Day

Normalize the `to` query param to end-of-day: when the API receives `to=2026-03-27`, set the filter to `createdAt < 2026-03-28T00:00:00` (exclusive next-day) instead of `createdAt <= 2026-03-27T00:00:00` (which misses the entire day). Apply to both the list and export endpoints.

### 3c. Portal: Preserve Pagination Metadata

The apiClient response interceptor (`portal/src/services/apiClient.ts:51`) unwraps `{ success, data }` and discards `meta`. Update the interceptor: when the envelope contains a `meta` field, set `response.data = { data: envelope.data, meta: envelope.meta }` instead of just `envelope.data`. When no `meta` is present, keep the current behavior (`response.data = envelope.data`) so existing callers are unaffected. The `useAdminAuditLogs` hook then returns `{ data, meta }` to the component.

### 3d. Portal: Server-Side Filters

Replace the client-side text search with server-side filters in `AdminAuditLogs.tsx`:

- **Date range**: two date inputs (from/to), passed as `from` and `to` query params.
- **Action type**: dropdown with known actions (`user.deactivated`, `user.reactivated`, `invite.sent`, `invite.resent`, `invite.cancelled`, `tenant.created`, `tenant.updated`, `tenant.suspended`, `tenant.activated`, `apikey.rotated`, `user.role_changed`, `user.deleted`, `user.promoted`, `user.demoted`), passed as the `action` query param.
- **Tenant**: keep existing tenant dropdown but fetch with `limit=1000` (or a dedicated unpaginated endpoint) to avoid the 20-tenant cap. This is a simple param override in `useAdminTenants`.

All filter changes re-trigger the `useAdminAuditLogs` query with updated params.

### 3e. Portal: Export Button

Add a "Download CSV" button in the page header:

- Calls `GET /admin/audit-logs/export` with the currently active filter params (tenantId, from, to, action).
- Uses `fetch` + blob download to trigger the browser file download (preserves auth headers from the apiClient instance).
- No additional backend changes needed beyond the tenant name addition in 3a.

### 3f. Portal: Pagination

Add server-side pagination using the existing `Pagination` component (`portal/src/components/ui/Pagination.tsx`):

- Track `page` state in the component, pass `page` and `limit=25` as query params to `useAdminAuditLogs`.
- Read `meta.totalPages` from the response (available once 3c is done).
- Render the `Pagination` component at the table footer with `page`, `totalPages`, and `onPageChange` props.
- Reset page to 1 when any filter changes.

---

## 4. Dialog Text Fix

### Problem

The deactivation confirmation in `Team.tsx` says "Remove Member" / "This action cannot be undone" / "Remove" — all implying irreversible deletion when deactivation is reversible.

### Fix

Change all three parts of the dialog:

- **Title**: "Remove Member" → "Deactivate Member"
- **Body**: "Remove this member from the organization? This action cannot be undone." → "Deactivate this member? They will lose access to the organization. You can reactivate them later."
- **Confirm button**: "Remove" → "Deactivate"

---

## 5. Tests

### Scope

Route-level integration tests for the new and modified backend endpoints. These set the foundation for Phase 2 (Testing & Reliability) without requiring the full test infrastructure buildout.

### What to Test

**Session cleanup (section 1):**
- Deactivating a user with active sessions returns success and nulls `assignedAgentId`, sets session status to `waiting`.
- Deactivating a user with accepted handoff requests resets them to `requested`.
- Deactivating a user with no agent record succeeds without error.

**Super-admin invite endpoints (section 2):**
- Resend returns updated invite with new `expiresAt`.
- Resend on non-existent invite returns 404.
- Cancel deletes the record and returns 204.
- Cancel on non-existent invite returns 404.
- Both reject non-super-admin callers.

**Audit log fixes (section 3):**
- `GET /admin/audit-logs` returns `tenantName` in response.
- Date range `to=2026-03-27` includes events from that full day.
- CSV export includes `tenant_name` column.
- Pagination params return correct `meta.totalPages`.

---

## Summary

| # | Change | Backend | Frontend | Effort |
|---|--------|---------|----------|--------|
| 1 | Session cleanup on deactivation | Shared helper with transaction support, wire into 3 endpoints | None | Medium |
| 2 | Super-admin invite resend/cancel | 2 new endpoints using existing Clerk wrapper | Buttons + 2 hooks + dual query invalidation | Medium |
| 3a | Audit log tenant name resolution | Join Tenant in query + add to CSV | None | Small |
| 3b | Date range end-of-day fix | Normalize `to` param in list + export | None | Small |
| 3c | Preserve pagination metadata | None | Fix apiClient interceptor | Small |
| 3d | Audit log server-side filters | None | Date range + action dropdown + tenant limit fix | Medium |
| 3e | Audit log export button | None | Download button using fetch + blob | Small |
| 3f | Audit log pagination | None | Wire existing Pagination component | Small |
| 4 | Dialog text fix | None | Title + body + button text | Tiny |
| 5 | Route-level tests | Tests for sections 1, 2, 3 | None | Medium |

All changes are scoped to existing files plus one new helper (`releaseAgentSessions.ts`) and new test files. No new entities, migrations, or architectural changes.
