# Clerk Sync & Authorization Model — Design Spec

**Date:** 2026-03-26
**Status:** Approved
**Depends on:** `2026-03-26-super-admin-design.md` (super admin role must exist first)

## Overview

Establish a clean separation: Clerk owns identity/membership, our DB owns authorization. Add Clerk API writes for super admin lifecycle operations (create org, invite user, suspend, name sync, deactivate). Fix the autoProvision role-overwrite bug so DB role changes persist. This is the foundation for future custom tenant RBAC.

## Core Principle

| Concern | Owner | What it means |
|---------|-------|---------------|
| Authentication (who are you?) | Clerk | Login, SSO, MFA, session management, token verification |
| Org membership (who is in which org?) | Clerk | Invites, join/leave, org creation/deletion |
| Authorization (what can you do?) | Our DB | Roles, permissions, access control |

Clerk is never consulted for permission checks. The DB role is authoritative after initial provisioning.

---

## Section 1: Fix the Role-Overwrite Bug

### The problem

`autoProvision` in `clerk.middleware.ts` reads the Clerk org membership role on every cache miss (~lines 160-169) and applies it to the user. If a super admin or tenant admin changes a user's role via the admin panel, the next cache miss overwrites it back to the Clerk-mapped role.

### The fix

Change autoProvision to only set role from Clerk on **first user creation**, not on subsequent logins:

```
// Current (broken):
// Every cache miss → fetch Clerk membership → overwrite user.role

// New:
// User exists in DB → keep DB role, skip Clerk role fetch
// User is new → fetch Clerk membership → set initial role
```

Specifically in `clerk.middleware.ts`, the role mapping block (~lines 160-169) should be wrapped in the `if (!user)` / new user branch only. For existing users, skip the `getOrganizationMembershipList` call entirely.

### Impact

- Existing role assignments are preserved
- Super admin role changes stick
- Tenant admin role changes (future) stick
- One fewer Clerk API call per returning user (perf improvement)
- Clerk Dashboard role changes no longer affect the app (acceptable — all role management moves to our portal)

**Cache staleness note:** The autoProvision 5-minute in-memory cache means role changes take up to 5 minutes to take effect for currently active users. This is acceptable latency. Cache invalidation across multiple API instances would require Redis pub/sub, which is over-engineering for now. Document as a known limitation.

---

## Section 2: Clerk API Writes — Phase 1 (Must-Have)

### 2a. Create Organization (super admin creates tenant)

When `POST /admin/tenants` is called:

1. Call `clerkClient.organizations.create({ name })` — do NOT pass `createdBy`, because that would make the super admin a member of every org they create. The org starts empty; the initial admin is added via invite (step 2b).
2. Get back `organization.id` (the `clerkOrgId`)
3. Create local Tenant record with `clerkOrgId`, generated slug, generated apiKey
4. Return tenant with ID

**Error handling:**
- If Clerk API fails → return 502 "Failed to create organization"
- If Clerk succeeds but local DB fails → attempt to delete the Clerk org (compensating transaction), return 500
- If both fail → return 500, log for manual cleanup

### 2b. Invite User (super admin invites user to a tenant)

New endpoint: `POST /admin/tenants/:id/invite`

Body: `{ email, role }` (role is our app role: admin/supervisor/agent — `super_admin` is NOT a valid invite role; super admin promotion is exclusively via `SUPER_ADMIN_EMAILS` env var or the promote endpoint)

Flow:
1. Look up tenant → get `clerkOrgId`
2. Call `clerkClient.organizationInvitations.create({ organizationId: clerkOrgId, emailAddress: email, role: 'org:member', inviterUserId: req.user.clerkUserId })` — pass `inviterUserId` so the invite email shows who sent it
   - Always use `org:member` in Clerk — our DB will set the real role
3. Store a `PendingInvite` record in DB: `{ tenantId, email, role, invitedBy, createdAt }`
   - If a PendingInvite already exists for this `(tenantId, email)`, **upsert**: update the `role`, `invitedBy`, and `createdAt` fields. Log the change. This handles re-invites or role changes before the user accepts.
4. When the user accepts the invite and logs in, autoProvision creates them. Check `PendingInvite` by matching against **all of the user's verified Clerk email addresses** (not just the primary) — Clerk users may sign up with a different email than the one invited. If found, use the stored role instead of mapping from Clerk membership. Delete the PendingInvite record.

**Why `org:member` for all Clerk invites:** Clerk role is irrelevant since DB owns authorization. Using `org:member` avoids needing custom Clerk roles.

**Why PendingInvite:** The Clerk invite and autoProvision happen at different times. We need to bridge the gap between "super admin chose role X" and "user signs up later." The PendingInvite record carries the intended role.

### 2c. Deactivate User (remove from Clerk org)

When `PATCH /admin/users/:id` sets `isActive: false`, or a dedicated deactivate endpoint:

1. Set `user.isActive = false` in DB
2. Remove from Clerk org. **Important:** Verify the exact method name against `@clerk/backend@^3.2.2` SDK — it may be `clerkClient.organizations.deleteOrganizationMembership()` or `clerkClient.organizationMemberships.delete()` depending on the version. Check the SDK types before implementing.
3. This prevents the user from logging in via Clerk (they're no longer in the org)

**Error handling:**
- If Clerk API fails → still deactivate locally (API-level block works as fallback), log warning for manual cleanup

**Reactivation path:**
- Set `user.isActive = true` in DB and update `user.role` to the desired role directly
- Call `clerkClient.organizationInvitations.create()` to re-invite them to the Clerk org
- No PendingInvite needed — the user already exists in DB, so autoProvision takes the existing-user branch which keeps the DB role as-is

### 2d. Role Changes (DB-only, no Clerk call)

When super admin or tenant admin changes a user's role:

1. Update `user.role` in DB
2. Done. No Clerk API call.

Clerk's org membership role stays as `org:member`. Our app ignores it after initial provisioning.

---

## Section 3: Clerk API Writes — Phase 2 (Nice-to-Have)

### 3a. Name Sync (rename tenant → rename Clerk org)

When `PATCH /admin/tenants/:id` changes the name:

1. Update local Tenant name
2. Call `clerkClient.organizations.update({ organizationId: clerkOrgId, name: newName })`
3. If Clerk call fails → local name is updated, log warning. Clerk name will be stale but not broken.

### 3b. Suspend Tenant (disable Clerk org)

When `POST /admin/tenants/:id/suspend`:

1. Set `tenant.status = 'suspended'` in DB
2. Call `clerkClient.organizations.update({ organizationId: clerkOrgId, publicMetadata: { suspended: true } })`
3. **Backend enforcement:** Add a check in the tenant-resolution middleware (or autoProvision): if `tenant.status === 'suspended'`, return 403 with `{ error: 'Organization suspended', code: 'TENANT_SUSPENDED' }`. This is the security control — it blocks API access regardless of how the request is made.
4. **Frontend UX:** Additionally, check `organization.publicMetadata.suspended` in `OrganizationRequired.tsx` or `AppAuthProvider.tsx` — if true, show a "Your organization has been suspended. Contact support." message. This provides a clear user-facing message instead of raw 403 errors.

### 3c. Activate Tenant (re-enable Clerk org)

When `POST /admin/tenants/:id/activate`:

1. Set `tenant.status = 'active'` in DB
2. Call `clerkClient.organizations.update({ organizationId: clerkOrgId, publicMetadata: { suspended: false } })`

### 3d. Tenant Admin Inviting Users

The existing Team page lets tenant admins invite users. Currently this goes through Clerk's frontend SDK (`useOrganization().inviteMemberships`). This continues to work, but we need to handle the role assignment:

- Add a step after the Clerk invite: create a `PendingInvite` record with the chosen role
- Or: change the Team page to call our backend `POST /tenants/me/invite` endpoint instead of Clerk's frontend SDK, which handles both the Clerk invite and PendingInvite in one call

The second approach is cleaner — it mirrors the super admin flow and keeps all invite logic in one place.

---

## Section 4: PendingInvite Entity

New TypeORM entity:

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | |
| `tenantId` | uuid (FK → Tenant) | Which tenant the invite is for |
| `email` | varchar(255) | Invited user's email (lowercase) |
| `role` | varchar(50) | Intended app role (admin/supervisor/agent) |
| `invitedBy` | uuid (FK → User) | Who sent the invite |
| `createdAt` | timestamp | When the invite was created |
| `expiresAt` | timestamp | Auto-expire after 7 days |

Index: `(tenantId, email)` unique — one pending invite per email per tenant.

**Lifecycle:**
- Created when super admin or tenant admin invites a user
- Consumed by autoProvision on first login (sets role, deletes record)
- Expired records: add `AND expires_at > NOW()` to the PendingInvite lookup in autoProvision. A periodic cleanup of old rows is optional but recommended (e.g., weekly cron deleting `WHERE expiresAt < NOW() - INTERVAL '30 days'`)

---

## Section 5: autoProvision Changes Summary

The autoProvision function (`clerk.middleware.ts`) needs these changes:

1. **New user creation branch:**
   - Before fetching Clerk membership role, check `PendingInvite` for this email + tenant
   - If PendingInvite found → use its role, delete the record
   - If no PendingInvite → fall back to Clerk role mapping (backwards compat for users invited directly through Clerk Dashboard). **Important:** Use `clerkClient.organizations.getOrganizationMembership({ organizationId, userId })` (single-member lookup) instead of `getOrganizationMembershipList()` — the list endpoint is paginated (default 10) and may miss the user in large orgs.

2. **Existing user branch:**
   - Skip the `getOrganizationMembershipList()` call entirely
   - Keep the DB role as-is
   - Still sync email verification status (existing behavior)

3. **SUPER_ADMIN_EMAILS check:**
   - Stays as designed in the super admin spec — runs after user resolution, promotes if email matches

---

## Section 6: New API Endpoints Summary

### Super admin endpoints (under `/api/v1/admin/`)

| Endpoint | Method | Clerk API call | Phase |
|----------|--------|---------------|-------|
| `/admin/tenants` | POST | `organizations.create()` | 1 |
| `/admin/tenants/:id` | PATCH | `organizations.update({ name })` if name changed | 2 |
| `/admin/tenants/:id/suspend` | POST | `organizations.update({ publicMetadata })` | 2 |
| `/admin/tenants/:id/activate` | POST | `organizations.update({ publicMetadata })` | 2 |
| `/admin/tenants/:id/invite` | POST | `organizationInvitations.create()` | 1 |
| `/admin/users/:id` (deactivate) | PATCH | `organizationMemberships.delete()` | 1 |

### Tenant admin endpoint (under `/api/v1/tenants/me/`)

| Endpoint | Method | Clerk API call | Phase |
|----------|--------|---------------|-------|
| `/tenants/me/invite` | POST | `organizationInvitations.create()` | 2 |

---

## Error Handling Strategy

All Clerk API calls follow the same pattern:

1. **Make DB change first** (optimistic) — except for org creation where Clerk must succeed first
2. **Call Clerk API** — if it fails, log a warning but don't roll back the DB change
3. **Exception: org creation** — Clerk must succeed before creating local Tenant (can't have a tenant without a Clerk org)

This means:
- Clerk downtime doesn't break existing tenant/user management (DB changes still apply)
- Only "create tenant" and "invite user" are blocked during Clerk outages
- A background reconciliation job (future) can fix any Clerk/DB drift

---

## Frontend Changes

### Suspension UX

In `portal/src/auth/OrganizationRequired.tsx` or `AppAuthProvider.tsx`:

```
// After loading org, check publicMetadata
if (organization?.publicMetadata?.suspended) {
  // Show "Your organization has been suspended. Contact support."
  // Don't render the app
}
```

### Team page overhaul

**Invite flow:** Replace Clerk's frontend invite SDK with a call to `POST /tenants/me/invite`. This ensures PendingInvite records are created and roles are correctly assigned.

**Role management:** The existing Team page Members tab has a role dropdown (`Team.tsx:607-616`) that calls `organization.updateMember({ userId, role })` — this writes to Clerk, which contradicts the DB-owned authorization model. This dropdown must be rewired to call a backend endpoint (`PATCH /tenants/me/users/:id` with `{ role }`) that updates the DB only. The dropdown options should show app roles (admin/supervisor/agent) instead of Clerk roles (`org:admin`/`org:member`).

---

## Testing

- **Unit:** autoProvision skips role overwrite for existing users
- **Unit:** autoProvision reads PendingInvite for new users
- **Integration:** create tenant → Clerk org exists → invite user → user signs up → correct role assigned
- **Integration:** deactivate user → removed from Clerk org → can't log in
- **Integration:** suspend tenant → Clerk org metadata updated → frontend shows suspension message
- **Integration:** role change persists across logins (no overwrite)

## Security

- All Clerk API calls use the server-side `CLERK_SECRET_KEY` — never exposed to frontend
- `PendingInvite` records are scoped to tenant — can't invite someone to a tenant you don't admin
- `expiresAt` prevents stale invites from being honored months later
- Deactivating a user both removes Clerk membership AND sets `isActive: false` (defense in depth)

## Design Rationale: Why Not Clerk Webhooks?

An alternative to PendingInvite is Clerk webhooks (`organization.invitation.accepted`, `organizationMembership.created`) which would allow real-time sync. We chose PendingInvite because:
- Webhooks add infrastructure complexity (delivery guarantees, retry handling, idempotency)
- We already have autoProvision running on every login — the pull model is simpler and already proven
- PendingInvite is a single DB query per new user, not a whole webhook processing pipeline
- If we add Clerk webhooks later (for the email verification spec), we can migrate to that model then

## Future (Not In Scope)

- Custom tenant RBAC (per-org role definitions, permission editor) — this spec is the foundation
- Background reconciliation job for Clerk/DB drift
- Bulk invite (CSV upload)
- SSO/SAML per tenant (different auth provider per org)
