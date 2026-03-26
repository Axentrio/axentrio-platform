# Super Admin — Design Spec

**Date:** 2026-03-26
**Status:** Approved
**Approach:** B — Role + Tenant Context Switcher

## Overview

Add a platform-level super admin role that can manage all tenants, users, and view cross-tenant analytics. Super admins can switch into any tenant's context to view/manage their data. Bootstrapped via `SUPER_ADMIN_EMAILS` env var, with UI-based promotion for subsequent super admins.

## Context

### What exists

- 3 hardcoded roles: `admin | supervisor | agent` on User entity
- `requireRole()` and `requireAdmin` middleware for route protection
- Frontend `ProtectedRoute` with `requiredRoles` prop, `ROLE_PERMISSIONS` map, `hasPermission()` in auth context
- Clerk integration with `autoProvision` middleware mapping `org:admin` → admin, `org:supervisor` → supervisor, default → agent
- Each user belongs to exactly one tenant (direct FK, no join table)
- Existing admin routes under `/api/v1/tenants/me/*` for tenant-scoped management
- Type discrepancy: `api/src/types/index.ts` has `'viewer'` role not used anywhere

### What's missing

- No platform-level admin concept — highest role is tenant-scoped `admin`
- No cross-tenant visibility or management
- No tenant context switching (impersonation)
- No platform-wide analytics

---

## Section 1: Schema & Role Changes

### UserRole enum

Add `'super_admin'` to the type:

```typescript
export type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'agent';
```

Fix the discrepancy in `api/src/types/index.ts` — replace the `'viewer'` value with `'super_admin'` to align with the entity.

Add `isSuperAdmin()` helper to User entity.

### Bootstrapping

Env var `SUPER_ADMIN_EMAILS` — comma-separated list of emails.

In `autoProvision` middleware (`clerk.middleware.ts`), after resolving/creating the user:
- If user's email is in `SUPER_ADMIN_EMAILS` and their role is not `super_admin`, promote them.
- This runs on every authenticated request (cached by existing 5-min TTL), so it's effectively immediate.

No dedicated Platform tenant. Super admins stay in whatever Clerk org/tenant they belong to. The `super_admin` role grants cross-tenant powers regardless of which tenant they're in.

### Migration

- Alter `UserRole` enum type in PostgreSQL to add `'super_admin'`
- Remove `'viewer'` if it exists in the DB enum

---

## Section 2: Backend Middleware & Tenant Context Switching

### New middleware: `requireSuperAdmin`

Checks `req.user.role === 'super_admin'`. Returns 403 if not. Added in `middleware/index.ts`.

### Updated middleware: `requireAdmin`

Now allows both `admin` and `super_admin`:

```typescript
if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
  return res.status(403).json({ error: 'Admin access required' });
}
```

This means super admins can access all existing admin-only routes without changes.

### Tenant context switching: `resolveTenantContext`

New middleware that runs after auth, before route handlers:

- If user is `super_admin` AND request includes `X-Tenant-Context` header:
  - Verify the target tenant exists and is not suspended
  - Set `req.tenantId` to the target tenant's ID
  - If tenant doesn't exist → 404
  - If tenant is suspended → 403 with "Tenant is suspended"
- If user is `super_admin` AND no header → `req.tenantId` stays as their own tenant
- If user is NOT `super_admin` → header is ignored entirely

This lets super admins call any existing tenant-scoped endpoint (chats, agents, analytics, settings) with any tenant's data, without modifying those endpoints.

---

## Section 3: Super Admin API Endpoints

All under `/api/v1/admin/*`, protected by `requireSuperAdmin`.

### Tenant Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/tenants` | GET | List all tenants (paginated, searchable, filter by tier/status) |
| `/admin/tenants/:id` | GET | Tenant details with user count, session count |
| `/admin/tenants` | POST | Create tenant manually |
| `/admin/tenants/:id` | PATCH | Update tenant settings, tier, status |
| `/admin/tenants/:id/suspend` | POST | Suspend tenant (sets status to 'suspended') |
| `/admin/tenants/:id/activate` | POST | Reactivate suspended tenant |

### User Management (cross-tenant)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/users` | GET | List all users across tenants (paginated, searchable, filter by role/tenant) |
| `/admin/users/:id` | GET | User details |
| `/admin/users/:id` | PATCH | Update user role, active status |
| `/admin/users/:id/promote` | POST | Promote to super admin |
| `/admin/users/:id/demote` | POST | Demote super admin to previous role |

### Platform Analytics

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/analytics` | GET | Cross-tenant metrics: total tenants, users, sessions, messages/day, per-tenant breakdown |

---

## Section 4: Frontend

### Route guard

`SuperAdminRoute` component — wraps `/admin/*` routes. Checks `user.role === 'super_admin'`, redirects to `/` otherwise.

### Sidebar

When user is super admin, show an "Admin" section in the sidebar:
- Tenants → `/admin/tenants`
- Users → `/admin/users`
- Platform Analytics → `/admin/analytics`

### Tenant context switcher

Dropdown in the top nav bar (super admin only):
- Lists all tenants, searchable
- Selecting a tenant stores the ID in Zustand state and sends `X-Tenant-Context` header on all subsequent API calls
- Shows "Viewing as: {Tenant Name}" badge with clear button to return to own context
- When active, normal pages (dashboard, chats, agents, analytics) show the selected tenant's data

### Admin pages

**`/admin/tenants`** — Table: name, tier, status, user count, created date. Search, tier/status filters. Row actions: suspend, activate, edit. Click row → detail view.

**`/admin/users`** — Table: name, email, role, tenant name, active status, last login. Search, role/tenant filters. Row actions: edit role, promote/demote, deactivate.

**`/admin/analytics`** — Summary cards: total tenants, total users, active sessions, messages today. Tenant breakdown table: tenant name, users, sessions, messages, tier.

### Permission map update

Add `super_admin` to `ROLE_PERMISSIONS` and `rolePermissions`:

```typescript
super_admin: ['*'], // wildcard — all permissions
```

---

## Error Handling

- **Context switch to non-existent tenant:** 404 response, frontend shows error toast
- **Context switch to suspended tenant:** 403 response, frontend shows warning
- **Promote already-super-admin:** 400 "User is already a super admin"
- **Demote last super admin:** 400 "Cannot demote the last super admin" — always keep at least one
- **Self-demotion:** Allowed, but with confirmation dialog ("You will lose super admin access")

## Security

- `X-Tenant-Context` header is only respected for `super_admin` role — ignored for all other roles
- Tenant context switching is logged (audit trail): who switched to which tenant, when
- `requireSuperAdmin` middleware is separate from `requireAdmin` — no accidental escalation
- Super admin promotion requires existing super admin — only the env var bootstrap bypasses this

## Testing

- Unit: `requireSuperAdmin` middleware rejects non-super-admin
- Unit: `resolveTenantContext` sets correct tenantId from header, ignores for non-super-admin
- Integration: super admin can list/manage tenants via `/admin/tenants`
- Integration: super admin can view another tenant's chats via `X-Tenant-Context`
- Integration: promote/demote flow, including last-super-admin guard
- Integration: `SUPER_ADMIN_EMAILS` bootstrap on autoProvision

## Future (Not In Scope)

- Custom tenant-level RBAC (per-org role definitions and permission editor)
- Audit log UI for super admin actions
- Super admin session recording / activity log
