# Clerk Sync & Authorization Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish DB-owned authorization with Clerk-owned identity, fix the role-overwrite bug, add Clerk API writes for tenant/user lifecycle, and introduce PendingInvite for role bridging.

**Architecture:** Fix autoProvision to only set role on first login (not overwrite on subsequent logins). Add PendingInvite entity to bridge invite→signup role assignment. Add Clerk API calls for org creation, user invite, deactivation, name sync, and suspension. Rewire Team page from Clerk SDK to backend endpoints.

**Tech Stack:** Express.js, TypeORM, PostgreSQL, `@clerk/express` v2.0.6, `@clerk/backend` v3.2.2, React 18, React Query, Clerk React SDK

**Spec:** `docs/superpowers/specs/2026-03-26-clerk-sync-design.md`
**Depends on:** `docs/superpowers/plans/2026-03-26-super-admin-plan.md` (super admin role + admin routes must exist)

**Base path:** `chatbot-platform/` (all relative paths below are from this root)

---

## File Structure

### Files to Create
- `api/src/database/entities/PendingInvite.ts` — PendingInvite entity
- `api/src/database/migrations/<timestamp>-CreatePendingInvite.ts` — migration
- `api/src/services/clerk-sync.service.ts` — wrapper around Clerk API calls (org create, invite, deactivate, name sync, suspend)

### Files to Modify
- `api/src/middleware/clerk.middleware.ts:79-256` — fix role-overwrite bug, add PendingInvite lookup, use single-member role lookup
- `api/src/routes/admin.routes.ts` — update tenant create, add invite endpoint, update deactivate, add name sync + suspend Clerk calls
- `api/src/routes/tenants.ts` — add `POST /tenants/me/invite` and `PATCH /tenants/me/users/:id` for tenant-admin role changes
- `api/src/server.ts:100` — add backend suspension check middleware
- `portal/src/pages/Team.tsx` — rewire invite and role change from Clerk SDK to backend endpoints
- `portal/src/auth/AppAuthProvider.tsx` or `portal/src/auth/OrganizationRequired.tsx` — add frontend suspension check

---

## Task 0: Add clerkUserId to RequestUser type

**Files:**
- Modify: `api/src/types/index.ts`

- [ ] **Step 1: Add clerkUserId to RequestUser interface**

In `api/src/types/index.ts`, find the `RequestUser` interface and add `clerkUserId`:

```typescript
export interface RequestUser {
  id: string;
  email: string;
  role: UserRole;
  tenantId: string;
  clerkUserId?: string; // Added for Clerk sync operations
  type?: string;
}
```

Also update `attachToRequest` in `clerk.middleware.ts` to populate `req.user.clerkUserId`:

```typescript
// In attachToRequest function, add:
req.user = {
  ...req.user,
  clerkUserId,
} as RequestUser;
```

- [ ] **Step 2: Export cache invalidation function from clerk.middleware.ts**

In `api/src/middleware/clerk.middleware.ts`, add an exported function after the cache helpers (~line 53):

```typescript
export function invalidateProvisionCache(orgId: string, userId: string): void {
  idCache.delete(`${orgId}:${userId}`);
}
```

This will be called by admin routes after role/status changes.

- [ ] **Step 3: Commit**

```bash
git add api/src/types/index.ts api/src/middleware/clerk.middleware.ts
git commit -m "feat: add clerkUserId to RequestUser and export cache invalidation"
```

---

## Task 1: Fix the autoProvision Role-Overwrite Bug

**Files:**
- Modify: `api/src/middleware/clerk.middleware.ts:136-194`

This is the most critical change — without it, all subsequent role management is broken.

- [ ] **Step 1: Move role mapping into new-user-only branch**

In `api/src/middleware/clerk.middleware.ts`, the role determination block (lines 158-169) is already inside the `if (!user)` → `else` branch (new user path). However, there's a subtlety: for users matched by email (migration path, lines 150-156), we should also skip role overwrite since they're existing users being linked.

Read the full function to confirm the current flow. The change is:
- Lines 157-169 (the `else` block for brand new users): Keep the Clerk role mapping here — this is correct for first-time users.
- Lines 150-156 (migration path — existing user linked to Clerk): Ensure we do NOT set role here. The existing user keeps their DB role.
- After user is resolved (line 194+): Do NOT call `getOrganizationMembershipList()` again for existing users. This call should only happen in the new-user branch.

**Verify:** Search for any code after line 194 that might also read/set the role from Clerk. The email verification sync (lines 197-211) is fine — it doesn't touch role.

- [ ] **Step 2: Replace getOrganizationMembershipList with single-member lookup**

In the new-user role determination block (lines 160-168), replace:

```typescript
// Use list with limit:100 to handle larger orgs
// Note: @clerk/backend v3.2.2 does NOT have a single-member lookup method
const memberships = await clerkClient.organizations.getOrganizationMembershipList({
  organizationId: clerkOrgId,
  limit: 100,
});
const membership = memberships.data?.find((m) => m.publicUserData?.userId === clerkUserId);
if (membership?.role === 'org:admin') role = 'admin';
else if (membership?.role === 'org:supervisor') role = 'supervisor';
// All other Clerk roles (org:member, etc.) → 'agent' (default)
```

**Known limitation:** For orgs with 100+ members, the list may not include the user. This only affects the Clerk-role fallback path (when no PendingInvite exists), which is a backwards-compat path for Clerk Dashboard invites. For orgs this large, use PendingInvite-based invites exclusively.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/middleware/clerk.middleware.ts
git commit -m "fix: only set role from Clerk on first user creation, not on subsequent logins"
```

---

## Task 2: PendingInvite Entity

**Files:**
- Create: `api/src/database/entities/PendingInvite.ts`

- [ ] **Step 1: Create the entity**

Create `api/src/database/entities/PendingInvite.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Tenant } from './Tenant';
import { User } from './User';

@Entity('pending_invites')
@Index(['tenantId', 'email'], { unique: true })
export class PendingInvite {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 50 })
  role!: string;

  @Column({ type: 'uuid', name: 'invited_by', nullable: true })
  invitedBy?: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'invited_by' })
  inviter?: User;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamp', name: 'expires_at' })
  expiresAt!: Date;
}
```

- [ ] **Step 2: Register entity in data source**

Check the TypeORM data source config and add `PendingInvite` to the entity list if entities are explicitly listed (rather than using glob patterns).

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/database/entities/PendingInvite.ts
git commit -m "feat: add PendingInvite entity for invite→signup role bridging"
```

---

## Task 3: PendingInvite Migration

**Files:**
- Create: `api/src/database/migrations/<timestamp>-CreatePendingInvite.ts`

- [ ] **Step 1: Generate migration**

Run: `cd chatbot-platform/api && npx typeorm migration:create src/database/migrations/CreatePendingInvite`

- [ ] **Step 2: Write the migration**

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePendingInvite<timestamp> implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE pending_invites (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL,
        invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL,
        CONSTRAINT uq_pending_invite_tenant_email UNIQUE (tenant_id, email)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS pending_invites`);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add api/src/database/migrations/
git commit -m "feat: add migration for pending_invites table"
```

---

## Task 4: PendingInvite Lookup in autoProvision

**Files:**
- Modify: `api/src/middleware/clerk.middleware.ts:138-193`

- [ ] **Step 1: Import PendingInvite entity**

At the top of `clerk.middleware.ts`, add:

```typescript
import { PendingInvite } from '../database/entities/PendingInvite';
```

- [ ] **Step 2: Add PendingInvite lookup before Clerk role mapping**

In the new-user branch (after email is fetched from Clerk at line 144, before the role determination at line 158), add:

```typescript
// Check for PendingInvite — bridges invite→signup role assignment
const pendingInviteRepo = AppDataSource.getRepository(PendingInvite);

// Match against all verified Clerk email addresses, not just primary
let clerkEmails: string[] = [email.toLowerCase()];
try {
  const clerkUser = await clerkClient.users.getUser(clerkUserId);
  clerkEmails = (clerkUser.emailAddresses || [])
    .filter(e => e.verification?.status === 'verified')
    .map(e => e.emailAddress.toLowerCase());
  if (clerkEmails.length === 0) clerkEmails = [email.toLowerCase()];
} catch {
  // Already fetched above — reuse email
}

const pendingInvite = await pendingInviteRepo
  .createQueryBuilder('pi')
  .where('pi.tenantId = :tenantId', { tenantId: tenant.id })
  .andWhere('pi.email IN (:...emails)', { emails: clerkEmails })
  .andWhere('pi.expiresAt > NOW()')
  .getOne();
```

**Note:** The Clerk user is already fetched at line 143. Refactor to reuse that result instead of fetching twice. Store the Clerk user object in a variable and use it both for name/email extraction and for PendingInvite email matching.

- [ ] **Step 3: Use PendingInvite role if found, otherwise fall back to Clerk mapping**

Replace the role determination block (lines 158-169) with:

```typescript
let role: 'admin' | 'supervisor' | 'agent' = 'agent';

if (pendingInvite) {
  // Use the role assigned during invite
  role = pendingInvite.role as 'admin' | 'supervisor' | 'agent';
  // Consume the invite
  await pendingInviteRepo.remove(pendingInvite);
  logger.info('Used PendingInvite for role assignment', {
    email, tenantId: tenant.id, role, invitedBy: pendingInvite.invitedBy,
  });
} else {
  // Backwards compat: fall back to Clerk membership role for Clerk Dashboard invites
  try {
    const memberships = await clerkClient.organizations.getOrganizationMembershipList({
      organizationId: clerkOrgId,
      limit: 100,
    });
    const membership = memberships.data?.find((m) => m.publicUserData?.userId === clerkUserId);
    if (membership?.role === 'org:admin') role = 'admin';
    else if (membership?.role === 'org:supervisor') role = 'supervisor';
  } catch {
    logger.warn('Could not fetch Clerk membership role', { clerkUserId, clerkOrgId });
  }
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add api/src/middleware/clerk.middleware.ts
git commit -m "feat: add PendingInvite lookup in autoProvision for role bridging"
```

---

## Task 5: Clerk Sync Service

**Files:**
- Create: `api/src/services/clerk-sync.service.ts`

- [ ] **Step 1: Create the service**

Create `api/src/services/clerk-sync.service.ts`:

```typescript
import { clerkClient } from '@clerk/express';
import { logger } from '../utils/logger';

/**
 * Thin wrapper around Clerk API calls for tenant/user lifecycle operations.
 * All methods are non-throwing — they log errors and return success/failure.
 */

export async function createClerkOrganization(name: string): Promise<{ id: string } | null> {
  try {
    const org = await clerkClient.organizations.createOrganization({ name });
    logger.info('Created Clerk organization', { clerkOrgId: org.id, name });
    return { id: org.id };
  } catch (error) {
    logger.error('Failed to create Clerk organization', { error, name });
    return null;
  }
}

export async function inviteToClerkOrganization(
  clerkOrgId: string,
  email: string,
  inviterClerkUserId?: string
): Promise<boolean> {
  try {
    await clerkClient.organizations.createOrganizationInvitation({
      organizationId: clerkOrgId,
      emailAddress: email,
      role: 'org:member', // Always org:member — DB owns authorization
      inviterUserId: inviterClerkUserId || undefined,
    });
    logger.info('Sent Clerk organization invite', { clerkOrgId, email });
    return true;
  } catch (error) {
    logger.error('Failed to send Clerk invite', { error, clerkOrgId, email });
    return false;
  }
}

export async function removeFromClerkOrganization(
  clerkOrgId: string,
  clerkUserId: string
): Promise<boolean> {
  try {
    // Verify exact method name against @clerk/backend v3.2.2 SDK
    // May be: clerkClient.organizations.deleteOrganizationMembership()
    // or: clerkClient.organizationMemberships.deleteOrganizationMembership()
    // Check SDK types before implementing:
    // grep -r "deleteOrganization\|removeMember" node_modules/@clerk/backend/dist/ --include="*.d.ts"
    await clerkClient.organizations.deleteOrganizationMembership({
      organizationId: clerkOrgId,
      userId: clerkUserId,
    });
    logger.info('Removed user from Clerk organization', { clerkOrgId, clerkUserId });
    return true;
  } catch (error) {
    logger.error('Failed to remove from Clerk org', { error, clerkOrgId, clerkUserId });
    return false;
  }
}

export async function updateClerkOrganization(
  clerkOrgId: string,
  updates: { name?: string; publicMetadata?: Record<string, unknown> }
): Promise<boolean> {
  try {
    // Note: updateOrganization uses positional args in @clerk/backend v3.2.2
    await clerkClient.organizations.updateOrganization(clerkOrgId, updates);
    logger.info('Updated Clerk organization', { clerkOrgId, updates: Object.keys(updates) });
    return true;
  } catch (error) {
    logger.error('Failed to update Clerk organization', { error, clerkOrgId });
    return false;
  }
}
```

**Important:** Before implementing, verify the exact method names against the installed SDK:

```bash
cd chatbot-platform/api && grep -r "createOrganization\b\|createOrganizationInvitation\|deleteOrganizationMembership\|updateOrganization" node_modules/@clerk/backend/dist/ --include="*.d.ts" | head -20
```

Adjust method names to match the actual SDK API.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add api/src/services/clerk-sync.service.ts
git commit -m "feat: add Clerk sync service for org/user lifecycle operations"
```

---

## Task 6: Update Admin Routes — Tenant Create with Clerk Org

**Files:**
- Modify: `api/src/routes/admin.routes.ts` (the `POST /tenants` handler from super admin plan)

- [ ] **Step 1: Wire Clerk org creation into tenant create**

In `api/src/routes/admin.routes.ts`, update the `POST /tenants` handler:

```typescript
import {
  createClerkOrganization,
  inviteToClerkOrganization,
} from '../services/clerk-sync.service';
import { PendingInvite } from '../database/entities/PendingInvite';

router.post('/tenants', async (req: Request, res: Response) => {
  try {
    const { name, tier, settings, adminEmail } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Step 1: Create Clerk org first — can't have a tenant without it
    const clerkOrg = await createClerkOrganization(name);
    if (!clerkOrg) {
      return res.status(502).json({ error: 'Failed to create organization in Clerk' });
    }

    // Step 2: Create local Tenant record
    const repo = AppDataSource.getRepository(Tenant);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const apiKey = `ak_${crypto.randomUUID().replace(/-/g, '')}`;

    let tenant;
    try {
      tenant = repo.create({
        name,
        slug,
        apiKey,
        clerkOrgId: clerkOrg.id,
        tier: tier || 'free',
        settings,
      });
      await repo.save(tenant);
    } catch (dbError) {
      // Compensating transaction: delete the Clerk org
      logger.error('Failed to create tenant in DB, cleaning up Clerk org', { error: dbError });
      try {
        await clerkClient.organizations.deleteOrganization(clerkOrg.id);
      } catch (cleanupErr) {
        logger.error('Failed to clean up Clerk org after DB failure — manual cleanup needed', {
          clerkOrgId: clerkOrg.id, error: cleanupErr,
        });
      }
      return res.status(500).json({ error: 'Failed to create tenant' });
    }

    // Step 3: Invite initial admin if email provided
    if (adminEmail) {
      await inviteToClerkOrganization(clerkOrg.id, adminEmail, req.user!.clerkUserId);

      const inviteRepo = AppDataSource.getRepository(PendingInvite);
      await inviteRepo.save(inviteRepo.create({
        tenantId: tenant.id,
        email: adminEmail.toLowerCase(),
        role: 'admin',
        invitedBy: req.userId!,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      }));
    }

    return res.status(201).json({ success: true, data: tenant });
  } catch (error) {
    logger.error('Failed to create tenant', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

**Important:** Read the existing `POST /tenants` handler from the super admin plan (Task 5) and replace it with this version. Also check how `ensureUniqueSlug` works in `clerk.middleware.ts:108` — the slug generation here is simplified and may need to handle uniqueness conflicts.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/admin.routes.ts
git commit -m "feat: create Clerk org when super admin creates tenant"
```

---

## Task 7: Admin Routes — Invite Endpoint

**Files:**
- Modify: `api/src/routes/admin.routes.ts`

- [ ] **Step 1: Add invite endpoint**

Append to `api/src/routes/admin.routes.ts`:

```typescript
// POST /admin/tenants/:id/invite — invite user to a tenant
router.post('/tenants/:id/invite', async (req: Request, res: Response) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ error: 'Email and role are required' });
    }

    // Validate role — super_admin cannot be assigned via invite
    if (!['admin', 'supervisor', 'agent'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be admin, supervisor, or agent' });
    }

    const tenantRepo = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.findOne({ where: { id: req.params.id } });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    if (!tenant.clerkOrgId) {
      return res.status(400).json({ error: 'Tenant has no Clerk organization linked' });
    }

    // Send Clerk invite
    const invited = await inviteToClerkOrganization(
      tenant.clerkOrgId,
      email,
      req.user!.clerkUserId
    );
    if (!invited) {
      return res.status(502).json({ error: 'Failed to send invite via Clerk' });
    }

    // Create or upsert PendingInvite
    const inviteRepo = AppDataSource.getRepository(PendingInvite);
    await inviteRepo
      .createQueryBuilder()
      .insert()
      .into(PendingInvite)
      .values({
        tenantId: tenant.id,
        email: email.toLowerCase(),
        role,
        invitedBy: req.userId!,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .orUpdate(['role', 'invited_by', 'created_at', 'expires_at'], ['tenant_id', 'email'])
      .execute();

    logger.info('Invited user to tenant', { tenantId: tenant.id, email, role, invitedBy: req.userId });
    return res.json({ success: true, message: 'Invitation sent' });
  } catch (error) {
    logger.error('Failed to invite user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/admin.routes.ts
git commit -m "feat: add super admin invite endpoint with PendingInvite"
```

---

## Task 8: Admin Routes — Deactivate User with Clerk Removal

**Files:**
- Modify: `api/src/routes/admin.routes.ts` (update the `PATCH /admin/users/:id` handler)

- [ ] **Step 1: Add Clerk org removal on deactivation**

In the existing `PATCH /admin/users/:id` handler, when `isActive` is set to `false`, add:

```typescript
import { removeFromClerkOrganization } from '../services/clerk-sync.service';
import { invalidateProvisionCache } from '../middleware/clerk.middleware';

// Inside the handler, after setting isActive:
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

  // Invalidate cache so deactivation takes effect immediately
  if (user.clerkUserId) {
    const t = tenant || await AppDataSource.getRepository(Tenant).findOne({ where: { id: user.tenantId } });
    if (t?.clerkOrgId) {
      invalidateProvisionCache(t.clerkOrgId, user.clerkUserId);
    }
  }

  // If reactivating, they'll need a re-invite (handled separately)
}
```

- [ ] **Step 2: Add reactivation endpoint**

Add a dedicated endpoint for reactivation:

```typescript
// POST /admin/users/:id/reactivate
router.post('/users/:id/reactivate', async (req: Request, res: Response) => {
  try {
    const { role } = req.body; // Optional new role
    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: req.params.id } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.isActive) {
      return res.status(400).json({ error: 'User is already active' });
    }

    // Update DB
    user.isActive = true;
    if (role && ['admin', 'supervisor', 'agent'].includes(role)) {
      user.role = role;
    }
    await userRepo.save(user);

    // Re-invite to Clerk org
    if (user.clerkUserId) {
      const tenant = await AppDataSource.getRepository(Tenant).findOne({
        where: { id: user.tenantId },
      });
      if (tenant?.clerkOrgId) {
        await inviteToClerkOrganization(tenant.clerkOrgId, user.email, req.user!.clerkUserId);
      }
    }

    logger.info('Reactivated user', { userId: user.id, role: user.role });
    return res.json({ success: true, data: user });
  } catch (error) {
    logger.error('Failed to reactivate user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/admin.routes.ts
git commit -m "feat: add Clerk org removal on user deactivation and reactivation endpoint"
```

---

## Task 9: Admin Routes — Name Sync and Suspend (Phase 2)

**Files:**
- Modify: `api/src/routes/admin.routes.ts` (update PATCH and suspend/activate handlers)

- [ ] **Step 1: Add Clerk name sync to tenant update**

In the `PATCH /admin/tenants/:id` handler, after updating the local tenant name, add:

```typescript
import { updateClerkOrganization } from '../services/clerk-sync.service';

// After: await repo.save(tenant);
if (name && tenant.clerkOrgId) {
  await updateClerkOrganization(tenant.clerkOrgId, { name });
}
```

- [ ] **Step 2: Add Clerk metadata update to suspend/activate**

In the `POST /admin/tenants/:id/suspend` handler, after setting local status, add:

```typescript
if (tenant.clerkOrgId) {
  await updateClerkOrganization(tenant.clerkOrgId, {
    publicMetadata: { suspended: true },
  });
}
```

In the `POST /admin/tenants/:id/activate` handler, add:

```typescript
if (tenant.clerkOrgId) {
  await updateClerkOrganization(tenant.clerkOrgId, {
    publicMetadata: { suspended: false },
  });
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/admin.routes.ts
git commit -m "feat: sync tenant name and suspension state to Clerk org"
```

---

## Task 10: Backend Suspension Enforcement

**Files:**
- Modify: `api/src/middleware/clerk.middleware.ts:96-133` (in autoProvision, after tenant resolution)

- [ ] **Step 1: Add suspension check in autoProvision**

In `clerk.middleware.ts`, after the tenant is resolved (after line 133), add:

```typescript
// Block access for suspended tenants
if (tenant.status === 'suspended') {
  res.status(403).json({
    error: 'Organization suspended',
    code: 'TENANT_SUSPENDED',
  });
  return;
}
```

This is the security control — it blocks all API access for suspended tenants regardless of how the request is made.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add api/src/middleware/clerk.middleware.ts
git commit -m "feat: block API access for suspended tenants in autoProvision"
```

---

## Task 11: Tenant Admin Invite & Role Change Endpoints

**Files:**
- Modify: `api/src/routes/tenants.ts` (add invite and role change endpoints)

- [ ] **Step 1: Add tenant-scoped invite endpoint**

In `api/src/routes/tenants.ts`, add:

```typescript
import { inviteToClerkOrganization } from '../services/clerk-sync.service';
import { PendingInvite } from '../database/entities/PendingInvite';
import { invalidateProvisionCache } from '../middleware/clerk.middleware';

// POST /tenants/me/invite — tenant admin invites a user
router.post('/me/invite', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ error: 'Email and role are required' });
    }

    if (!['admin', 'supervisor', 'agent'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const tenantRepo = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.findOne({ where: { id: req.tenantId } });

    if (!tenant?.clerkOrgId) {
      return res.status(400).json({ error: 'No Clerk organization linked' });
    }

    const invited = await inviteToClerkOrganization(
      tenant.clerkOrgId,
      email,
      req.user!.clerkUserId
    );
    if (!invited) {
      return res.status(502).json({ error: 'Failed to send invite' });
    }

    const inviteRepo = AppDataSource.getRepository(PendingInvite);
    await inviteRepo
      .createQueryBuilder()
      .insert()
      .into(PendingInvite)
      .values({
        tenantId: tenant.id,
        email: email.toLowerCase(),
        role,
        invitedBy: req.userId!,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .orUpdate(['role', 'invited_by', 'created_at', 'expires_at'], ['tenant_id', 'email'])
      .execute();

    return res.json({ success: true, message: 'Invitation sent' });
  } catch (error) {
    logger.error('Failed to invite user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

- [ ] **Step 2: Add tenant-scoped role change endpoint**

```typescript
// PATCH /tenants/me/users/:userId — tenant admin changes user role (DB-only)
router.patch('/me/users/:userId', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { role } = req.body;

    if (!role || !['admin', 'supervisor', 'agent'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: req.params.userId, tenantId: req.tenantId },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found in this tenant' });
    }

    user.role = role;
    await userRepo.save(user);

    // Invalidate autoProvision cache so the role change takes effect immediately
    if (user.clerkUserId) {
      const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: req.tenantId } });
      if (tenant?.clerkOrgId) {
        invalidateProvisionCache(tenant.clerkOrgId, user.clerkUserId);
      }
    }

    logger.info('Tenant admin changed user role', {
      userId: user.id, newRole: role, changedBy: req.userId,
    });
    return res.json({ success: true, data: { id: user.id, role: user.role } });
  } catch (error) {
    logger.error('Failed to change user role', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

**Important:** Read the existing `tenants.ts` to find:
- How `requireAdmin` is imported (from `middleware/index.ts`)
- How `req.tenantId` and `req.userId` are set (from autoProvision)
- Whether `Tenant`, `User`, `AppDataSource` are already imported

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/tenants.ts
git commit -m "feat: add tenant admin invite and role change endpoints"
```

---

## Task 12: Frontend — Suspension Check

**Files:**
- Modify: `portal/src/auth/OrganizationRequired.tsx` or `portal/src/auth/AppAuthProvider.tsx`

- [ ] **Step 1: Add suspension check**

In `portal/src/auth/OrganizationRequired.tsx` (~line 5), after loading the organization, add a suspension check:

```tsx
import { useOrganization } from '@clerk/clerk-react';

// Inside the component, after getting organization:
const { organization, isLoaded } = useOrganization();

if (isLoaded && organization?.publicMetadata?.suspended) {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center max-w-md p-8">
        <h1 className="text-2xl font-bold mb-4">Organization Suspended</h1>
        <p className="text-muted-foreground">
          Your organization has been suspended. Please contact support for assistance.
        </p>
      </div>
    </div>
  );
}
```

**Important:** Read the current `OrganizationRequired.tsx` to understand its structure and where to add this check. It should go before the normal org-required gate.

- [ ] **Step 2: Verify frontend compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add portal/src/auth/OrganizationRequired.tsx
git commit -m "feat: show suspension message instead of app for suspended orgs"
```

---

## Task 13: Frontend — Rewire Team Page

**Files:**
- Modify: `portal/src/pages/Team.tsx`

- [ ] **Step 1: Replace Clerk invite with backend endpoint**

In `portal/src/pages/Team.tsx`, find the invite/add member flow that uses Clerk's frontend SDK. Replace it with a call to the new backend endpoint:

```typescript
// Before (Clerk SDK):
// organization.inviteMember({ emailAddress, role: 'org:member' })

// After (backend endpoint):
const inviteMember = useMutation({
  mutationFn: async ({ email, role }: { email: string; role: string }) => {
    return api.post('/tenants/me/invite', { email, role });
  },
  onSuccess: () => {
    toast.success('Invitation sent');
    queryClient.invalidateQueries({ queryKey: ['team-members'] });
  },
  onError: (error: any) => {
    toast.error(error.response?.data?.error || 'Failed to send invite');
  },
});
```

- [ ] **Step 2: Replace Clerk role dropdown with backend endpoint**

Find the role change dropdown (that calls `organization.updateMember`). Replace with:

```typescript
// Before (Clerk SDK):
// organization.updateMember({ userId, role: 'org:admin' })

// After (backend endpoint):
const updateRole = useMutation({
  mutationFn: async ({ userId, role }: { userId: string; role: string }) => {
    return api.patch(`/tenants/me/users/${userId}`, { role });
  },
  onSuccess: () => {
    toast.success('Role updated');
    queryClient.invalidateQueries({ queryKey: ['team-members'] });
  },
});
```

Update the role dropdown options from Clerk roles to app roles:

```tsx
// Before:
<SelectItem value="org:admin">Admin</SelectItem>
<SelectItem value="org:member">Member</SelectItem>

// After:
<SelectItem value="admin">Admin</SelectItem>
<SelectItem value="supervisor">Supervisor</SelectItem>
<SelectItem value="agent">Agent</SelectItem>
```

- [ ] **Step 3: Update member list to use backend data**

If the Team page fetches members from Clerk's SDK, switch to fetching from `GET /tenants/me/users` (which already exists in the tenant routes). This ensures roles shown match the DB, not Clerk.

- [ ] **Step 4: Verify frontend compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/Team.tsx
git commit -m "feat: rewire Team page from Clerk SDK to backend invite/role endpoints"
```

---

## Task 14: Manual E2E Verification

- [ ] **Step 1: Test role persistence**

1. Log in as a user → note their role
2. Change their role via admin panel → verify DB updated
3. Log out and log back in → verify the role didn't revert to Clerk mapping
4. Check the autoProvision cache expires (wait 5 min or restart server) → verify role still correct

- [ ] **Step 2: Test tenant creation with Clerk org**

1. As super admin, create a new tenant via `POST /admin/tenants` with `{ name: "Test Org", adminEmail: "test@example.com" }`
2. Verify Clerk org was created (check Clerk Dashboard)
3. Verify `test@example.com` received an invite email
4. Accept the invite, sign up → verify user gets `admin` role (from PendingInvite)

- [ ] **Step 3: Test user deactivation**

1. Deactivate a user via admin panel
2. Verify they're removed from Clerk org (check Clerk Dashboard)
3. Verify they can't log in
4. Reactivate them → verify re-invite sent → they can log in again

- [ ] **Step 4: Test suspension**

1. Suspend a tenant via `POST /admin/tenants/:id/suspend`
2. As a user of that tenant, try to access the app → verify "Organization Suspended" message
3. Try to call API directly → verify 403 with `TENANT_SUSPENDED` code
4. Activate the tenant → verify access is restored

- [ ] **Step 5: Test Team page role change**

1. As a tenant admin, go to Team page
2. Change a user's role via the dropdown
3. Verify the role updates in DB (not in Clerk)
4. Invite a new user with a specific role → verify PendingInvite created

---

## Execution Order

All tasks are sequential:

```
Task 0:  Add clerkUserId to RequestUser + export cache invalidation
  → Task 1:  Fix role-overwrite bug (critical foundation)
    → Task 2:  PendingInvite entity
    → Task 3:  PendingInvite migration
      → Task 4:  PendingInvite lookup in autoProvision
        → Task 5:  Clerk sync service
          → Task 6:  Tenant create with Clerk org (Phase 1)
            → Task 7:  Invite endpoint (Phase 1)
              → Task 8:  Deactivate with Clerk removal (Phase 1)
                → Task 9:  Name sync + suspend Clerk calls (Phase 2)
                  → Task 10: Backend suspension enforcement (Phase 2)
                    → Task 11: Tenant admin invite + role endpoints (Phase 2)
                      → Task 12: Frontend suspension check (Phase 2)
                        → Task 13: Rewire Team page (Phase 2)
                          → Task 14: E2E verification
```

**Phase 1 boundary:** After Task 8, the core system works — roles persist, tenants are created with Clerk orgs, users can be invited (by super admin) and deactivated. **Known Phase 1 limitation:** The existing Team page still uses Clerk's frontend SDK for invites, meaning tenant-admin invites won't create PendingInvite records and new users will fall back to Clerk role mapping. This is fixed in Phase 2 (Tasks 11 + 13).

**Phase 2 boundary:** Tasks 9-13 add name sync, suspension, and Team page rewiring.
