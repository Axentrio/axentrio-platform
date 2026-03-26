# Super Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a platform-level super admin role with cross-tenant management, tenant context switching, and admin UI under `/admin/*`.

**Architecture:** Add `super_admin` to existing `UserRole` enum. Bootstrap via `SUPER_ADMIN_EMAILS` env var in autoProvision. New `requireSuperAdmin` and `resolveTenantContext` middleware. Admin API at `/api/v1/admin/*`. Frontend admin pages at `/admin/*` with tenant context switcher in top nav.

**Tech Stack:** Express.js, TypeORM, PostgreSQL, Clerk, React 18, React Query, Zustand, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-26-super-admin-design.md`

**Base path:** `chatbot-platform/` (all relative paths below are from this root)

---

## File Structure

### Files to Create
- `api/src/database/migrations/<timestamp>-AddSuperAdminRole.ts` — migration
- `api/src/middleware/super-admin.middleware.ts` — requireSuperAdmin + resolveTenantContext
- `api/src/routes/admin.routes.ts` — all `/admin/*` endpoints
- `portal/src/auth/SuperAdminRoute.tsx` — route guard
- `portal/src/pages/admin/AdminTenants.tsx` — tenant management page
- `portal/src/pages/admin/AdminUsers.tsx` — user management page
- `portal/src/pages/admin/AdminAnalytics.tsx` — platform analytics page
- `portal/src/components/admin/TenantContextSwitcher.tsx` — tenant dropdown
- `portal/src/stores/tenantContextStore.ts` — Zustand store for active tenant context

### Files to Modify
- `api/src/database/entities/User.ts:20,101-115` — add super_admin to enum, add helper
- `api/src/types/index.ts:105-119` — fix UserRole discrepancy, add super_admin
- `api/src/middleware/clerk.middleware.ts:158-169` — add SUPER_ADMIN_EMAILS check in autoProvision
- `api/src/middleware/index.ts:51-57` — update requireAdmin to allow super_admin
- `api/src/config/environment.ts` — add SUPER_ADMIN_EMAILS env var
- `api/src/server.ts:110-122` — mount admin routes
- `portal/src/types/index.ts:5` — add super_admin to UserRole
- `portal/src/config/constants.ts:71-95` — add super_admin to ROLE_PERMISSIONS
- `portal/src/auth/AppAuthProvider.tsx:19-40` — add super_admin to rolePermissions
- `portal/src/auth/ProtectedRoute.tsx` — no changes needed (already role-based)
- `portal/src/App.tsx:161-220` — add admin routes
- `portal/src/components/layout/` — add Admin section to sidebar, add context switcher to nav

---

## Task 1: UserRole Enum & Entity Changes

**Files:**
- Modify: `api/src/database/entities/User.ts:20,101-115`
- Modify: `api/src/types/index.ts:105-119`

- [ ] **Step 1: Update UserRole type in User entity**

In `api/src/database/entities/User.ts`, change line 20:

```typescript
// Before:
export type UserRole = 'admin' | 'supervisor' | 'agent';

// After:
export type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'agent';
```

- [ ] **Step 2: Add isSuperAdmin helper and update canAccessAdminPanel**

In `api/src/database/entities/User.ts`, add after the existing helper methods (~line 115):

```typescript
isSuperAdmin(): boolean {
  return this.role === 'super_admin';
}
```

Also update `canAccessAdminPanel()` (~line 113-115) to include super_admin:

```typescript
canAccessAdminPanel(): boolean {
  return this.role === 'super_admin' || this.role === 'admin' || this.role === 'supervisor';
}
```

- [ ] **Step 3: Fix UserRole and narrow RequestUser.role in types/index.ts**

In `api/src/types/index.ts`, find the `UserRole` type (~line 105-119) and replace:

```typescript
// Before:
export type UserRole = 'admin' | 'agent' | 'viewer';

// After:
export type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'agent';
```

Also find `RequestUser` interface (~line 12) and change `role: string` to `role: UserRole` so TypeScript catches role comparison bugs.

- [ ] **Step 4: Update frontend UserRole type**

In `portal/src/types/index.ts` (~line 5):

```typescript
// Before:
export type UserRole = 'admin' | 'supervisor' | 'agent';

// After:
export type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'agent';
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`
Run: `cd chatbot-platform/portal && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add api/src/database/entities/User.ts api/src/types/index.ts portal/src/types/index.ts
git commit -m "feat: add super_admin to UserRole enum and fix type discrepancy"
```

---

## Task 2: Database Migration

**Files:**
- Create: `api/src/database/migrations/<timestamp>-AddSuperAdminRole.ts`

- [ ] **Step 1: Generate migration**

Run: `cd chatbot-platform/api && npx typeorm migration:create src/database/migrations/AddSuperAdminRole`

- [ ] **Step 2: Determine the actual enum type name**

Before writing the migration, query the database to find the exact enum name:
```sql
SELECT typname FROM pg_type WHERE typname LIKE '%role%';
```
TypeORM typically generates names like `users_role_enum` (table_column_enum). Use the actual name in the next step.

- [ ] **Step 3: Write the migration**

Replace `<ACTUAL_ENUM_NAME>` with the value from Step 2:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSuperAdminRole<timestamp> implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add super_admin to the user role enum
    // Use the actual enum type name from: SELECT typname FROM pg_type WHERE typname LIKE '%role%';
    await queryRunner.query(`
      ALTER TYPE <ACTUAL_ENUM_NAME> ADD VALUE IF NOT EXISTS 'super_admin' BEFORE 'admin'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL doesn't support removing enum values directly.
    // To roll back, create a new type without super_admin and migrate the column.
    // For safety, this is a no-op. Demote super_admin users before rollback.
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add api/src/database/migrations/
git commit -m "feat: add migration for super_admin role enum value"
```

---

## Task 3: Config & Super Admin Bootstrap

**Files:**
- Modify: `api/src/config/environment.ts:98`
- Modify: `api/src/middleware/clerk.middleware.ts:158-169`

- [ ] **Step 1: Add SUPER_ADMIN_EMAILS to config**

In `api/src/config/environment.ts`, add the env var. Check if the config uses Zod for validation — if so, add it as a Zod field:

```typescript
// If Zod is used:
SUPER_ADMIN_EMAILS: z.string().default('').transform(v =>
  v.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
),

// If raw process.env:
superAdminEmails: (process.env.SUPER_ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean),
```

Read `environment.ts` to determine which pattern the file uses and match it.

- [ ] **Step 2: Add super admin check in autoProvision**

In `api/src/middleware/clerk.middleware.ts`, in the `autoProvision` function, after the user is resolved/created and the Clerk role mapping is applied (~lines 158-169), add:

```typescript
// Super admin override — check if user's email is in SUPER_ADMIN_EMAILS
if (config.superAdminEmails.includes(user.email.toLowerCase()) && user.role !== 'super_admin') {
  user.role = 'super_admin';
  await userRepo.save(user);
  logger.info('Promoted user to super_admin via SUPER_ADMIN_EMAILS', { email: user.email });
}
```

**Critical placement note:** The autoProvision function has a cache (5-min TTL, ~lines 86-90) that returns early on cache hit. The super admin check MUST be placed:
1. **Before the cache write** — so the promoted role is what gets cached
2. **After the cache early-return** — additionally, invalidate the cache entry if the user was promoted. After the promotion, delete the cache key so the next request picks up the new role:

```typescript
// After promotion, invalidate the cache
const cacheKey = `clerk_user:${clerkUserId}`;
provisionCache.delete(cacheKey); // or whatever the cache key pattern is
```

Read the full autoProvision function to find the exact cache mechanism and key pattern.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/config/environment.ts api/src/middleware/clerk.middleware.ts
git commit -m "feat: add SUPER_ADMIN_EMAILS bootstrap in autoProvision"
```

---

## Task 4: Super Admin Middleware

**Files:**
- Create: `api/src/middleware/super-admin.middleware.ts`
- Modify: `api/src/middleware/index.ts:51-57`

- [ ] **Step 1: Create super admin middleware**

Create `api/src/middleware/super-admin.middleware.ts`:

```typescript
import { Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { logger } from '../utils/logger';

/**
 * Requires the user to be a super admin. Returns 403 if not.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'super_admin') {
    res.status(403).json({ error: 'Super admin access required' });
    return;
  }
  next();
}

/**
 * Resolves tenant context from X-Tenant-Context header for super admins.
 * Non-super-admin users: header is ignored entirely.
 * Super admins without header: tenantId stays as their own.
 * Super admins with header: tenantId is set to the target tenant.
 */
export async function resolveTenantContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  const targetTenantId = req.headers['x-tenant-context'] as string | undefined;

  if (!targetTenantId || !req.user || req.user.role !== 'super_admin') {
    next();
    return;
  }

  try {
    const tenantRepo = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.findOne({ where: { id: targetTenantId } });

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    if (tenant.status === 'suspended') {
      res.status(403).json({ error: 'Tenant is suspended' });
      return;
    }

    req.tenantId = tenant.id;
    logger.info('Super admin context switch', {
      userId: req.userId,
      targetTenantId: tenant.id,
      targetTenantName: tenant.name,
    });

    next();
  } catch (error) {
    logger.error('Failed to resolve tenant context', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 2: Update requireAdmin to allow super_admin**

In `api/src/middleware/index.ts`, find `requireAdmin` (~line 51-57) and update:

```typescript
// Before:
if (req.user.role !== 'admin') {
  return res.status(403).json({ error: 'Admin access required' });
}

// After:
if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
  return res.status(403).json({ error: 'Admin access required' });
}
```

- [ ] **Step 3: Export new middleware from index**

In `api/src/middleware/index.ts`, add:

```typescript
export { requireSuperAdmin, resolveTenantContext } from './super-admin.middleware';
```

- [ ] **Step 4: Add X-Tenant-Context to CORS allowedHeaders**

In `api/src/server.ts` (~line 100), find the CORS config `allowedHeaders` array and add `'X-Tenant-Context'`:

```typescript
allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'X-Session-ID', 'X-Tenant-Context'],
```

Without this, the browser strips the header in preflight and tenant context switching silently fails.

- [ ] **Step 5: Wire resolveTenantContext at the ROUTE level, NOT globally**

**Important:** In this codebase, `requireClerkAuth` + `autoProvision` are applied per-route-file (not globally). The global `clerkMiddleware()` only populates Clerk auth state — it does NOT set `req.user`. So `resolveTenantContext` must be applied at the route level, after auth middleware sets `req.user`.

Do NOT add `app.use(resolveTenantContext)` globally. Instead, add it to each route file's middleware chain that should support context switching. For the admin routes, it's already handled (see Task 5). For existing routes (chats, agents, analytics, etc.), add `resolveTenantContext` after `requireClerkAuth, autoProvision`:

```typescript
// Example in chat.routes.ts:
router.use(requireClerkAuth, autoProvision, resolveTenantContext);
```

Apply `resolveTenantContext` to: `chat.routes.ts`, `agents.routes.ts`, `analytics.routes.ts`, `handsoff.routes.ts`, `notifications.routes.ts`, `users.routes.ts`. These are the routes a super admin would browse while impersonating a tenant.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add api/src/middleware/super-admin.middleware.ts api/src/middleware/index.ts api/src/server.ts
git commit -m "feat: add requireSuperAdmin and resolveTenantContext middleware"
```

---

## Task 5: Admin API Routes — Tenant Management

**Files:**
- Create: `api/src/routes/admin.routes.ts`
- Modify: `api/src/server.ts` (mount routes)

- [ ] **Step 1: Create admin routes file**

Create `api/src/routes/admin.routes.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { User } from '../database/entities/User';
import { ChatSession } from '../database/entities/ChatSession';
import { requireSuperAdmin } from '../middleware/super-admin.middleware';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { logger } from '../utils/logger';

const router = Router();

// All routes require Clerk auth + autoProvision + super admin
router.use(requireClerkAuth, autoProvision, requireSuperAdmin);

// ==================
// Tenant Management
// ==================

// GET /admin/tenants — list all tenants
router.get('/tenants', async (req: Request, res: Response) => {
  try {
    const params = parsePaginationParams(req.query);
    const qb = AppDataSource.getRepository(Tenant)
      .createQueryBuilder('tenant')
      .loadRelationCountAndMap('tenant.userCount', 'tenant.users');

    // Search filter
    const search = req.query.search as string;
    if (search) {
      qb.andWhere('(tenant.name ILIKE :search OR tenant.slug ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    // Tier filter
    const tier = req.query.tier as string;
    if (tier) {
      qb.andWhere('tenant.tier = :tier', { tier });
    }

    // Status filter
    const status = req.query.status as string;
    if (status) {
      qb.andWhere('tenant.status = :status', { status });
    }

    const result = await applyPagination(qb, params);
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Failed to list tenants', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/tenants/:id — tenant details
router.get('/tenants/:id', async (req: Request, res: Response) => {
  try {
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: req.params.id },
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Get counts
    const userCount = await AppDataSource.getRepository(User).count({
      where: { tenantId: tenant.id },
    });
    const sessionCount = await AppDataSource.getRepository(ChatSession).count({
      where: { tenantId: tenant.id },
    });

    return res.json({
      success: true,
      data: { ...tenant, userCount, sessionCount },
    });
  } catch (error) {
    logger.error('Failed to get tenant', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/tenants — create tenant
router.post('/tenants', async (req: Request, res: Response) => {
  try {
    const { name, tier, settings } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const repo = AppDataSource.getRepository(Tenant);

    // Generate slug and apiKey — these are required columns
    // Read the autoProvision function (~line 108-109 in clerk.middleware.ts) to see how
    // slug and apiKey are generated there, and replicate the same logic here.
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const apiKey = `ak_${crypto.randomUUID().replace(/-/g, '')}`;

    const tenant = repo.create({ name, slug, apiKey, tier: tier || 'free', settings });
    await repo.save(tenant);

    return res.status(201).json({ success: true, data: tenant });
  } catch (error) {
    logger.error('Failed to create tenant', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /admin/tenants/:id — update tenant
router.patch('/tenants/:id', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: req.params.id } });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { name, tier, status, settings } = req.body;
    if (name) tenant.name = name;
    if (tier) tenant.tier = tier;
    if (status) tenant.status = status;
    if (settings) tenant.settings = { ...tenant.settings, ...settings };

    await repo.save(tenant);
    return res.json({ success: true, data: tenant });
  } catch (error) {
    logger.error('Failed to update tenant', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/tenants/:id/suspend
router.post('/tenants/:id/suspend', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: req.params.id } });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    tenant.status = 'suspended';
    await repo.save(tenant);
    return res.json({ success: true, data: tenant });
  } catch (error) {
    logger.error('Failed to suspend tenant', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/tenants/:id/activate
router.post('/tenants/:id/activate', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: req.params.id } });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    tenant.status = 'active';
    await repo.save(tenant);
    return res.json({ success: true, data: tenant });
  } catch (error) {
    logger.error('Failed to activate tenant', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
```

**Important:** Check if `parsePaginationParams` / `applyPagination` exist yet. If not (pagination plan hasn't been implemented), use manual offset/limit or inline the logic.

- [ ] **Step 2: Mount admin routes in server.ts**

In `api/src/server.ts`, inside the apiRouter setup:

```typescript
import adminRoutes from './routes/admin.routes';

apiRouter.use('/admin', adminRoutes);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/admin.routes.ts api/src/server.ts
git commit -m "feat: add super admin tenant management API endpoints"
```

---

## Task 6: Admin API Routes — User Management & Analytics

**Files:**
- Modify: `api/src/routes/admin.routes.ts`

- [ ] **Step 1: Add user management endpoints**

Append to `api/src/routes/admin.routes.ts`:

```typescript
// ==================
// User Management
// ==================

// GET /admin/users — list all users across tenants
router.get('/users', async (req: Request, res: Response) => {
  try {
    const params = parsePaginationParams(req.query);
    const qb = AppDataSource.getRepository(User)
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.tenant', 'tenant');

    const search = req.query.search as string;
    if (search) {
      qb.andWhere('(user.name ILIKE :search OR user.email ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    const role = req.query.role as string;
    if (role) {
      qb.andWhere('user.role = :role', { role });
    }

    const tenantId = req.query.tenantId as string;
    if (tenantId) {
      qb.andWhere('user.tenantId = :tenantId', { tenantId });
    }

    const result = await applyPagination(qb, params);

    // Strip sensitive fields
    const data = result.data.map(u => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      isActive: u.isActive,
      tenantId: u.tenantId,
      tenantName: (u as any).tenant?.name,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    }));

    return res.json({ success: true, data, meta: result.meta });
  } catch (error) {
    logger.error('Failed to list users', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/users/:id — user details
router.get('/users/:id', async (req: Request, res: Response) => {
  try {
    const user = await AppDataSource.getRepository(User).findOne({
      where: { id: req.params.id },
      relations: ['tenant'],
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isActive: user.isActive,
        tenantId: user.tenantId,
        tenantName: user.tenant?.name,
        emailVerified: user.emailVerified,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    logger.error('Failed to get user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /admin/users/:id — update user
router.patch('/users/:id', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { role, isActive } = req.body;
    if (role && ['admin', 'supervisor', 'agent'].includes(role)) {
      user.role = role;
    }
    if (typeof isActive === 'boolean') {
      user.isActive = isActive;
    }

    await repo.save(user);
    return res.json({ success: true, data: user });
  } catch (error) {
    logger.error('Failed to update user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/users/:id/promote — promote to super admin
router.post('/users/:id/promote', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role === 'super_admin') {
      return res.status(400).json({ error: 'User is already a super admin' });
    }

    // Store previous role in metadata so we can restore it on demote
    // Add a previousRole field or use JSONB metadata on the User entity
    const previousRole = user.role;
    user.role = 'super_admin';
    // Store previousRole — either in a new column or in notificationPreferences/metadata
    // For simplicity, store as a custom property. Read User entity to find the best place.
    if (user.notificationPreferences) {
      user.notificationPreferences = { ...user.notificationPreferences, _previousRole: previousRole };
    } else {
      user.notificationPreferences = { _previousRole: previousRole };
    }
    await repo.save(user);

    logger.info('User promoted to super_admin', { promotedBy: req.userId, userId: user.id });
    return res.json({ success: true, data: user });
  } catch (error) {
    logger.error('Failed to promote user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/users/:id/demote — demote super admin
router.post('/users/:id/demote', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role !== 'super_admin') {
      return res.status(400).json({ error: 'User is not a super admin' });
    }

    // Guard: cannot demote the last super admin
    const superAdminCount = await repo.count({ where: { role: 'super_admin' } });
    if (superAdminCount <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last super admin' });
    }

    // Restore previous role if stored, otherwise default to 'admin'
    const previousRole = user.notificationPreferences?._previousRole;
    user.role = (previousRole && ['admin', 'supervisor', 'agent'].includes(previousRole))
      ? previousRole
      : 'admin';
    // Clean up stored previous role
    if (user.notificationPreferences?._previousRole) {
      const { _previousRole, ...rest } = user.notificationPreferences;
      user.notificationPreferences = rest;
    }
    await repo.save(user);

    logger.info('User demoted from super_admin', { demotedBy: req.userId, userId: user.id, newRole: user.role });
    return res.json({ success: true, data: user });
  } catch (error) {
    logger.error('Failed to demote user', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================
// Platform Analytics
// ==================

// GET /admin/analytics — cross-tenant metrics
router.get('/analytics', async (req: Request, res: Response) => {
  try {
    const tenantRepo = AppDataSource.getRepository(Tenant);
    const userRepo = AppDataSource.getRepository(User);
    const sessionRepo = AppDataSource.getRepository(ChatSession);

    const messageRepo = AppDataSource.getRepository('Message');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalTenants, totalUsers, totalSessions, activeSessions, messagesToday] = await Promise.all([
      tenantRepo.count({ where: { status: 'active' } }),
      userRepo.count({ where: { isActive: true } }),
      sessionRepo.count(),
      sessionRepo.count({ where: { status: 'active' } }),
      messageRepo.createQueryBuilder('m')
        .where('m.createdAt >= :today', { today })
        .getCount(),
    ]);

    // Per-tenant breakdown
    const tenantBreakdown = await tenantRepo
      .createQueryBuilder('t')
      .select('t.id', 'tenantId')
      .addSelect('t.name', 'name')
      .addSelect('t.tier', 'tier')
      .addSelect('COUNT(DISTINCT u.id)', 'userCount')
      .addSelect('COUNT(DISTINCT s.id)', 'sessionCount')
      .addSelect('COUNT(DISTINCT m.id)', 'messageCount')
      .leftJoin(User, 'u', 'u.tenant_id = t.id')
      .leftJoin(ChatSession, 's', 's.tenant_id = t.id')
      .leftJoin('messages', 'm', 'm.session_id = s.id')
      .where('t.status = :status', { status: 'active' })
      .groupBy('t.id')
      .addGroupBy('t.name')
      .addGroupBy('t.tier')
      .orderBy('"sessionCount"', 'DESC')
      .getRawMany();

    return res.json({
      success: true,
      data: {
        totalTenants,
        totalUsers,
        totalSessions,
        activeSessions,
        messagesToday,
        tenantBreakdown,
      },
    });
  } catch (error) {
    logger.error('Failed to get platform analytics', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

**Important:** Read the actual entity relations and column names before using the join queries. The SQL join conditions (`u.tenant_id`, `s.tenant_id`) must match the actual DB column names.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/admin.routes.ts
git commit -m "feat: add super admin user management and platform analytics endpoints"
```

---

## Task 7: Frontend — Permission Maps & Route Guard

**Files:**
- Modify: `portal/src/config/constants.ts:71-95`
- Modify: `portal/src/auth/AppAuthProvider.tsx:19-40`
- Create: `portal/src/auth/SuperAdminRoute.tsx`

- [ ] **Step 1: Add super_admin to ROLE_PERMISSIONS**

In `portal/src/config/constants.ts`, add before the `admin` entry in `ROLE_PERMISSIONS` (~line 72):

```typescript
super_admin: [
  'view:all_chats',
  'manage:agents',
  'manage:tenants',
  'manage:settings',
  'view:analytics',
  'takeover:any_chat',
  'manage:team',
  'admin:tenants',
  'admin:users',
  'admin:analytics',
],
```

- [ ] **Step 2: Add super_admin to rolePermissions and fix checkPermission in AppAuthProvider**

In `portal/src/auth/AppAuthProvider.tsx`:

First, add to the `rolePermissions` map (~line 20):

```typescript
super_admin: ['*'], // wildcard — all permissions
```

Then, find the `checkPermission` function (or `hasPermission`). It currently has a hardcoded shortcut for `admin` (~line 37-39):

```typescript
// Before:
if (role === 'admin') return true;

// After:
if (role === 'admin' || role === 'super_admin') return true;
```

Also find `mapClerkRole()` (~lines 13-17). This function maps Clerk org roles to app roles and may override the DB role. Ensure the frontend uses the DB role from the `/auth/me` endpoint response, NOT the Clerk-mapped role, for determining `super_admin` status. Read the auth flow to verify: if `mapClerkRole` runs after the backend returns the user's role, it would downgrade `super_admin` to `admin`. The fix is to skip `mapClerkRole` if the backend-returned role is `super_admin`.

- [ ] **Step 3: Create SuperAdminRoute guard**

Create `portal/src/auth/SuperAdminRoute.tsx`:

```tsx
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AppAuthProvider';

export function SuperAdminRoute() {
  const { user, isLoading } = useAuth();

  if (isLoading) return null;

  if (!user || user.role !== 'super_admin') {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
```

**Important:** Read `AppAuthProvider.tsx` and `ProtectedRoute.tsx` to verify the exact auth hook name and user object shape, then match the pattern.

- [ ] **Step 4: Verify frontend compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add portal/src/config/constants.ts portal/src/auth/AppAuthProvider.tsx portal/src/auth/SuperAdminRoute.tsx
git commit -m "feat: add super_admin permissions and route guard"
```

---

## Task 8: Frontend — Tenant Context Switcher Store

**Files:**
- Create: `portal/src/stores/tenantContextStore.ts`

- [ ] **Step 1: Create Zustand store**

Create `portal/src/stores/tenantContextStore.ts`:

```typescript
import { create } from 'zustand';

interface TenantContext {
  tenantId: string;
  tenantName: string;
}

interface TenantContextStore {
  activeTenant: TenantContext | null;
  setActiveTenant: (tenant: TenantContext | null) => void;
  clearTenant: () => void;
}

export const useTenantContextStore = create<TenantContextStore>((set) => ({
  activeTenant: null,
  setActiveTenant: (tenant) => set({ activeTenant: tenant }),
  clearTenant: () => set({ activeTenant: null }),
}));
```

- [ ] **Step 2: Wire the header into the API client**

Find the API client / axios instance used by the portal (likely in a services file or a shared `api` utility). Add an interceptor that injects `X-Tenant-Context` when the store has an active tenant:

```typescript
import { useTenantContextStore } from '../stores/tenantContextStore';

api.interceptors.request.use((config) => {
  const { activeTenant } = useTenantContextStore.getState();
  if (activeTenant) {
    config.headers['X-Tenant-Context'] = activeTenant.tenantId;
  }
  return config;
});
```

**Important:** Read the existing API client setup to find where interceptors are configured and add this there.

- [ ] **Step 3: Verify frontend compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add portal/src/stores/tenantContextStore.ts
git commit -m "feat: add tenant context switcher Zustand store with API interceptor"
```

---

## Task 9: Frontend — Tenant Context Switcher UI

**Files:**
- Create: `portal/src/components/admin/TenantContextSwitcher.tsx`
- Modify: portal layout component (top nav / header)

- [ ] **Step 1: Create TenantContextSwitcher component**

Create `portal/src/components/admin/TenantContextSwitcher.tsx`:

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTenantContextStore } from '../../stores/tenantContextStore';
import { useAuth } from '../../auth/AppAuthProvider';
import api from '../../services/api'; // adjust import path

export function TenantContextSwitcher() {
  const { user } = useAuth();
  const { activeTenant, setActiveTenant, clearTenant } = useTenantContextStore();
  const [search, setSearch] = useState('');

  // Only render for super admins
  if (!user || user.role !== 'super_admin') return null;

  const { data: tenants } = useQuery({
    queryKey: ['admin-tenants', search],
    queryFn: () => api.get(`/admin/tenants?search=${search}&limit=20`).then(r => r.data),
    enabled: true,
  });

  if (activeTenant) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-100 text-amber-800 rounded-md text-sm">
        <span>Viewing as: <strong>{activeTenant.tenantName}</strong></span>
        <button
          onClick={clearTenant}
          className="ml-1 hover:text-amber-900 underline"
        >
          Exit
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <select
        onChange={(e) => {
          const tenant = tenants?.data?.find((t: any) => t.id === e.target.value);
          if (tenant) {
            setActiveTenant({ tenantId: tenant.id, tenantName: tenant.name });
          }
        }}
        value=""
        className="text-sm border rounded-md px-2 py-1"
      >
        <option value="" disabled>Switch tenant...</option>
        {tenants?.data?.map((t: any) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
    </div>
  );
}
```

**Note:** This is a basic implementation. Read the existing nav/header component to match the UI patterns (Radix components, Tailwind classes, etc.). A searchable dropdown using the existing Select/Combobox pattern would be better than a plain `<select>`.

- [ ] **Step 2: Add to the top nav/header**

Find the layout header component and add `<TenantContextSwitcher />` next to the existing nav items. Only renders for super admins (component handles its own visibility).

- [ ] **Step 3: Verify frontend compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/admin/TenantContextSwitcher.tsx
git commit -m "feat: add tenant context switcher dropdown for super admins"
```

---

## Task 10: Frontend — Admin Pages

**Files:**
- Create: `portal/src/pages/admin/AdminTenants.tsx`
- Create: `portal/src/pages/admin/AdminUsers.tsx`
- Create: `portal/src/pages/admin/AdminAnalytics.tsx`
- Modify: `portal/src/App.tsx:161-220` (add routes)

- [ ] **Step 1: Create AdminTenants page**

Create `portal/src/pages/admin/AdminTenants.tsx`:

A table page listing all tenants. Fetch from `GET /admin/tenants`. Display columns: name, tier (badge), status (badge), user count, created date. Include search bar, tier/status filter dropdowns. Row actions: click to view detail, suspend/activate buttons.

**Important:** Read existing list pages (like the Team page or Tenants page) to match the exact table patterns, Tailwind classes, and component usage.

- [ ] **Step 2: Create AdminUsers page**

Create `portal/src/pages/admin/AdminUsers.tsx`:

A table page listing all users. Fetch from `GET /admin/users`. Display columns: name, email, role (badge), tenant name, active status, last login. Search bar, role/tenant filters. Row actions: edit role dropdown, promote/demote button (for super admin targets), deactivate toggle.

Include confirmation dialog for promote/demote actions.

- [ ] **Step 3: Create AdminAnalytics page**

Create `portal/src/pages/admin/AdminAnalytics.tsx`:

Summary cards at top: Total Tenants, Total Users, Active Sessions, Total Sessions. Below: tenant breakdown table with name, tier, user count, session count. Fetch from `GET /admin/analytics`.

- [ ] **Step 4: Add routes to App.tsx**

In `portal/src/App.tsx`, add inside the `<Routes>` block:

```tsx
import { SuperAdminRoute } from './auth/SuperAdminRoute';
import AdminTenants from './pages/admin/AdminTenants';
import AdminUsers from './pages/admin/AdminUsers';
import AdminAnalytics from './pages/admin/AdminAnalytics';

<Route element={<SuperAdminRoute />}>
  <Route path="/admin/tenants" element={<AdminTenants />} />
  <Route path="/admin/users" element={<AdminUsers />} />
  <Route path="/admin/analytics" element={<AdminAnalytics />} />
</Route>
```

- [ ] **Step 5: Add admin nav items to sidebar**

Find the sidebar/nav component. Add an "Admin" section (visible only to super admins) with links to `/admin/tenants`, `/admin/users`, `/admin/analytics`. Use a divider or section header to separate from normal nav items.

- [ ] **Step 6: Verify frontend compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add portal/src/pages/admin/ portal/src/App.tsx
git commit -m "feat: add super admin pages (tenants, users, analytics) and routes"
```

---

## Task 11: Manual E2E Verification

- [ ] **Step 1: Set SUPER_ADMIN_EMAILS and start the server**

```bash
SUPER_ADMIN_EMAILS=your@email.com npm run dev
```

Log in via Clerk. Verify logs show "Promoted user to super_admin".

- [ ] **Step 2: Verify admin nav and pages**

- Admin section appears in sidebar
- `/admin/tenants` shows all tenants
- `/admin/users` shows all users across tenants
- `/admin/analytics` shows platform metrics

- [ ] **Step 3: Test tenant context switching**

- Select a tenant from the dropdown
- Verify the "Viewing as: {name}" badge appears
- Navigate to Dashboard/Chats — verify it shows that tenant's data
- Click "Exit" — verify it returns to your own tenant's view

- [ ] **Step 4: Test promote/demote**

- Go to `/admin/users`, find another user, click "Promote to Super Admin"
- Verify they now appear with `super_admin` role
- Demote them back — verify guard prevents demoting last super admin

- [ ] **Step 5: Test suspend/activate**

- Go to `/admin/tenants`, suspend a tenant
- Try switching context to the suspended tenant — verify 403 error
- Activate the tenant — verify context switch works again

---

## Execution Order

All tasks are sequential:

```
Task 1: UserRole enum changes
  → Task 2: Database migration
    → Task 3: Config & bootstrap in autoProvision
      → Task 4: Middleware (requireSuperAdmin, resolveTenantContext)
        → Task 5: Admin API — tenant management
          → Task 6: Admin API — user management & analytics
            → Task 7: Frontend — permissions & route guard
              → Task 8: Frontend — context switcher store
                → Task 9: Frontend — context switcher UI
                  → Task 10: Frontend — admin pages & routing
                    → Task 11: Manual E2E verification
```
