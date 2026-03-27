# Phase 1 Gap-Closing Spec

> Close out the remaining gaps in Phase 1 (Finish Admin Gaps) before moving to Phase 2.

---

## 1. Session Cleanup on Member Deactivation

### Problem

When a member is deactivated, their assigned chat sessions and accepted handoff requests are not cleaned up. This orphans conversations. User deletion already handles this correctly; deactivation does not.

### Design

Extract a shared helper `releaseAgentSessions(agentId, tenantId, io)` used by both deactivation and deletion:

1. Query all `ChatSession` rows where `assignedAgentId = agentId` and status in (`active`, `handoff`).
2. Set `assignedAgentId = null` and status to `waiting` on each.
3. Query all `HandoffRequest` rows where `acceptedBy = agentId` and status is `accepted`. Set `acceptedBy = null`, status to `pending`.
4. Emit socket events per affected session:
   - `agent:removed` to the session room (`tenantId:sessionId`) so the visitor/widget knows.
   - `handoff:returned` to the tenant room (`tenantId`) so other agents see returned items in their queue.
5. Include count of reassigned sessions in the audit log metadata.

### Affected Endpoints

- `POST /admin/users/:id/deactivate` (admin.routes.ts)
- `POST /tenants/me/users/:userId/deactivate` (tenants.ts)
- Existing `DELETE /admin/users/:id` refactored to use the same helper.

### Helper Location

`api/src/utils/releaseAgentSessions.ts`

---

## 2. Super-Admin Invite Resend/Cancel

### Problem

Super-admins can list pending invites on `AdminTenantDetail` but cannot resend or cancel them. No API endpoints exist at the super-admin level for these actions.

### Design

**API — two new endpoints in `admin.routes.ts`:**

- `POST /admin/tenants/:id/pending-invites/:inviteId/resend`
  - Looks up `PendingInvite` by ID scoped to tenant ID.
  - Re-sends via `clerkClient.organizations.createInvitation()`.
  - Resets `expiresAt` to 7 days from now.
  - Logs `invite.resent` audit event.
  - Returns updated invite.

- `DELETE /admin/tenants/:id/pending-invites/:inviteId`
  - Looks up `PendingInvite` by ID scoped to tenant ID.
  - Deletes the record.
  - Logs `invite.cancelled` audit event.
  - Returns 204.

Both use the existing super-admin auth middleware (`requireSuperAdmin`).

**Portal — `AdminTenantDetail.tsx`:**

- Add Resend (rotate icon) and Cancel (X icon) buttons to each invite row, matching the pattern in `Team.tsx`.
- Two new hooks in `useAdminQueries.ts`: `useAdminResendInvite(tenantId)` and `useAdminCancelInvite(tenantId)`.
- On success, invalidate the `adminTenantDetail` query key.

---

## 3. Audit Log Viewer Improvements

### Problem

The API supports filtering by tenant, action, and date range plus CSV export, but the portal UI only has a client-side text search and tenant dropdown. No export button, no pagination.

### 3a. Filters

Replace the client-side text search with server-side filters in `AdminAuditLogs.tsx`:

- **Date range**: two date inputs (from/to), passed as `from` and `to` query params.
- **Action type**: dropdown with known actions (`user.deactivated`, `user.reactivated`, `invite.sent`, `invite.resent`, `invite.cancelled`, `tenant.created`, `tenant.updated`, `tenant.suspended`, `tenant.activated`, `apikey.rotated`, `user.role_changed`, `user.deleted`, `user.promoted`, `user.demoted`), passed as the `action` query param.
- **Tenant**: keep existing tenant dropdown.

All three filters are already supported by `GET /admin/audit-logs`. The query hook in `useAdminQueries.ts` just needs to forward the params.

### 3b. Export Button

Add a "Download CSV" button in the page header:

- Calls `GET /admin/audit-logs/export` with the currently active filter params (tenantId, from, to, action).
- Uses `fetch` + blob download to trigger the browser file download (preserves auth headers).
- The API already returns `Content-Type: text/csv` and `Content-Disposition: attachment` headers.
- No backend changes needed.

### 3c. Pagination

Add server-side pagination:

- Pass `page` and `limit` query params to `GET /admin/audit-logs` (already supported).
- Default page size: 25.
- Add pagination controls at the table footer, matching the existing pattern used in `AdminUsers`.
- The API already returns `total` count for calculating page numbers.

---

## 4. Dialog Text Fix

### Problem

The deactivation confirmation in `Team.tsx` says "This action cannot be undone," which is incorrect — deactivation is reversible.

### Fix

Change the dialog body in `Team.tsx` from:

> "Remove this member from the organization? This action cannot be undone."

To:

> "Deactivate this member? They will lose access to the organization. You can reactivate them later."

---

## Summary

| # | Change | Backend | Frontend | Effort |
|---|--------|---------|----------|--------|
| 1 | Session cleanup on deactivation | New shared helper, wire into 3 endpoints | None | Small-medium |
| 2 | Super-admin invite resend/cancel | 2 new endpoints | Buttons + 2 hooks in AdminTenantDetail | Medium |
| 3a | Audit log filters | None (API ready) | Date range + action dropdown | Small-medium |
| 3b | Audit log export button | None (API ready) | Download button | Small |
| 3c | Audit log pagination | None (API ready) | Pagination controls | Small |
| 4 | Dialog text fix | None | One string change | Tiny |

All changes are scoped to existing files. No new entities, migrations, or architectural changes.
