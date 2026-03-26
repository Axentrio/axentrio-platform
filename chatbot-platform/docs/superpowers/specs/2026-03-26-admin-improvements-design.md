# Admin & Tenant Management Improvements

**Date:** 2026-03-26
**Status:** Approved
**Scope:** Railway DB connection, member removal, pending invites, tenant detail view, audit logging

---

## Context

The multi-tenant architecture and super admin system are functional but have several gaps that block real-world usage: member removal isn't implemented, pending invites are invisible, there's no tenant detail view, no audit trail, and local development uses a separate Postgres that drifts from the shared Clerk instance.

## 1. Railway DB Connection

### Problem
Local dev runs a Docker Postgres on port 5433 while sharing the same Clerk dev instance (`sk_test_`). Users created via Clerk don't exist in the local DB and vice versa.

### Solution
Point local dev at the Railway Postgres by setting `DATABASE_URL` in `api/.env`.

### Changes
- Replace `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` in `api/.env` with `DATABASE_URL=<railway-connection-string>`
- Remove `DB_SYNC=true` (migrations are already the only schema management path in `data-source.ts`)
- Run migrations against Railway DB
- Keep `infra/docker-compose.yml` for offline dev — document as optional
- No code changes required; `config/environment.ts` already prioritizes `DATABASE_URL` over individual `DB_*` vars

---

## 2. Member Removal

### Problem
The "Remove" button on the Team page shows a toast message (`"Member removal is handled through the admin panel"`) with no actual backend endpoint.

### Backend
- **`POST /tenants/me/users/:userId/deactivate`**
  - Sets `user.isActive = false`
  - Calls `removeFromClerkOrganization(tenant.clerkOrgId, user.clerkUserId)` to remove from Clerk org
  - Invalidates the provision cache for that user
  - Guards: cannot deactivate yourself, cannot deactivate the last active admin in the tenant
  - Returns 400 with descriptive error for guard violations

- **Enhance existing `POST /admin/users/:id/reactivate`**
  - Currently only sets `isActive = true`
  - Also re-add user to Clerk org via `addMemberToClerkOrganization(tenant.clerkOrgId, user.clerkUserId, 'org:member')`

### Frontend (Team page)
- Replace toast-only "Remove" button with a confirmation dialog (`AlertDialog`)
- On confirm, call `POST /tenants/me/users/:userId/deactivate`
- Refresh member list on success
- Deactivated users show "Inactive" badge with a "Reactivate" button (calls `POST /tenants/me/users/:userId/reactivate`)

- **New: `POST /tenants/me/users/:userId/reactivate`** (tenant-level, for tenant admins)
  - Sets `user.isActive = true`
  - Re-adds to Clerk org via `addMemberToClerkOrganization()`
  - Mirrors the admin-level reactivate but scoped to current tenant

### Clerk Integration
- Deactivation: `removeFromClerkOrganization()` — user loses org access in Clerk immediately
- Reactivation: `addMemberToClerkOrganization()` — user regains org access
- User's Clerk account is NOT deleted — only org membership changes

---

## 3. Pending Invites Visibility + Resend

### Problem
No way to see who's been invited, whether invites expired, or retry failed Clerk emails.

### Backend

**Tenant-level endpoints (for tenant admins):**
- `GET /tenants/me/pending-invites` — list pending invites for current tenant
  - Returns: id, email, role, invitedBy (name + email), createdAt, expiresAt, isExpired (computed)
  - Sorted by createdAt DESC
- `POST /tenants/me/pending-invites/:id/resend` — re-send Clerk org invitation, reset expiresAt to 7 days from now
- `DELETE /tenants/me/pending-invites/:id` — cancel/revoke invite, delete PendingInvite record

**Admin-level endpoint (for super admins):**
- `GET /admin/tenants/:id/pending-invites` — view any tenant's pending invites (used in tenant detail view)

### Frontend (Team page)
- Add "Pending Invites" section below the members table
- Table columns: email, invited role, invited by, expires (relative time), actions
- Actions per row: "Resend" button, "Cancel" button
- Expired invites shown with warning styling
- List auto-refreshes after sending a new invite

### Clerk Integration
- Resend calls `inviteToClerkOrganization()` again with the same email — Clerk handles dedup or re-sends

---

## 4. Tenant Detail View

### Problem
Tenants are list-only in the admin panel. No way to drill into a tenant to see its users, invites, or settings.

### Backend Enhancements
- Enhance `GET /admin/tenants/:id` response to include:
  - Existing: tenant info, userCount, sessionCount
  - Add: `users` (first 10, with total count), `pendingInvites` (all), `apiKeyMasked` (e.g. `ak_****...3f2a`)
- New: `POST /admin/tenants/:id/api-key/rotate` — regenerate API key (currently only exists at tenant-level `/tenants/me/api-key/rotate`)

### New Page: `/admin/tenants/:id`

**Header:**
- Tenant name, tier badge, status badge, created date
- Action buttons: Suspend/Activate, Edit (name/tier modal), Invite User

**Sections:**

1. **Overview cards** — user count, session count, message count, API key (masked, click to reveal, rotate button)

2. **Members table** — users in this tenant: name, email, role, status, last login
   - Links to admin user detail if needed
   - Shows first 10 with "View all" link that navigates to admin users filtered by tenant

3. **Pending Invites** — same table as section 3, scoped to this tenant
   - Resend and cancel actions

4. **Audit Log** — recent admin actions on this tenant (newest first, 30s auto-refetch)
   - Shows: timestamp, actor, action, details

**Navigation:**
- Tenant name in All Tenants list becomes a link to `/admin/tenants/:id`
- Breadcrumb: All Tenants > {Tenant Name}

---

## 5. Audit Logging

### Problem
No record of who performed admin actions or when. Can't answer "who suspended this tenant?" or "who promoted this user?"

### Database

New `audit_logs` table:

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK, auto-generated |
| tenant_id | UUID | FK to tenants, nullable (null for platform-level actions) |
| actor_id | UUID | FK to users |
| action | VARCHAR(100) | e.g. `tenant.created`, `user.deactivated` |
| entity_type | VARCHAR(50) | `tenant`, `user`, `invite` |
| entity_id | UUID | ID of affected entity |
| metadata | JSONB | Optional extras, e.g. `{ "previousRole": "admin", "newRole": "super_admin" }` |
| created_at | TIMESTAMP | Indexed |

**Indexes:**
- `(tenant_id, created_at DESC)` — tenant detail view queries
- `(actor_id, created_at DESC)` — "what did this user do?" queries

**Migration:** New TypeORM migration to create table + indexes. No FK constraints on `actor_id` or `entity_id` (append-only, never cascaded). Actor name resolved via LEFT JOIN to `users` table on read queries.

### Actions to Log

| Action | Trigger |
|--------|---------|
| `tenant.created` | POST /admin/tenants |
| `tenant.updated` | PATCH /admin/tenants/:id |
| `tenant.suspended` | POST /admin/tenants/:id/suspend |
| `tenant.activated` | POST /admin/tenants/:id/activate |
| `user.promoted` | POST /admin/users/:id/promote |
| `user.demoted` | POST /admin/users/:id/demote |
| `user.deactivated` | POST /tenants/me/users/:id/deactivate |
| `user.reactivated` | POST /admin/users/:id/reactivate |
| `user.role_changed` | PATCH /admin/users/:id (role change) |
| `invite.sent` | POST /tenants/me/invite, POST /admin/tenants/:id/invite |
| `invite.resent` | POST /tenants/me/pending-invites/:id/resend |
| `invite.cancelled` | DELETE /tenants/me/pending-invites/:id |
| `apikey.rotated` | POST /admin/tenants/:id/api-key/rotate |

### Helper Function

```
logAudit(actorId, action, entityType, entityId, tenantId?, metadata?)
```

- Direct INSERT, fire-and-forget (wrapped in try/catch, logs error but doesn't block response)
- No separate service — simple utility function in `utils/audit.ts`

### Retention & Cleanup

- `AUDIT_RETENTION_DAYS` env var (default: 90)
- Cleanup: scheduled DELETE query — `DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '$retention days'`
- Triggered via a simple cron-like check on app startup or a periodic setInterval (daily)

### Export

- `GET /admin/audit-logs/export?format=csv&tenantId=...&from=...&to=...`
  - Filters: tenantId (optional), date range (from/to), action (optional)
  - Returns CSV with columns: timestamp, actor_email, actor_name, action, entity_type, entity_id, metadata
  - Sets `Content-Type: text/csv` and `Content-Disposition: attachment`
- Also per-tenant: `GET /admin/tenants/:id/audit-logs/export?format=csv&from=...&to=...`

### Frontend

- Audit log table in tenant detail view: timestamp, actor, action, metadata (30s `refetchInterval`)
- Optional platform-wide audit log tab in admin analytics page
- No real-time WebSocket — 30s auto-refetch via react-query is sufficient

---

## Implementation Order

1. Railway DB connection (env config only, unblocks everything)
2. Audit logging — migration + helper (other features will use it)
3. Member removal — endpoint + Clerk sync + Team page UI
4. Pending invites — endpoints + Team page UI
5. Tenant detail view — new page pulling everything together

Audit logging comes second so that steps 3-5 can wire in `logAudit()` calls as they're built.

---

## Out of Scope

- Bulk user import/CSV upload
- Organization switcher UI (Clerk component)
- Super admin email config UI (remains env var)
- Hard user deletion (soft-deactivate only)
- Multi-region database replication
