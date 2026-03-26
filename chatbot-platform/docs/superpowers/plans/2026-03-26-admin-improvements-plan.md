# Admin & Tenant Management Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix admin gaps — Railway DB, audit logging, member removal, pending invites visibility, and tenant detail view.

**Architecture:** Incremental additions to existing Express routes and React pages. New `audit_logs` table with `logAudit()` helper wired into all mutation endpoints. New tenant-level endpoints for deactivate/reactivate/pending-invites. New `/admin/tenants/:id` detail page aggregating members, invites, and audit logs.

**Tech Stack:** TypeORM migrations, Express routes, React + TanStack Query + shadcn/ui, Clerk SDK for org membership sync.

---

## File Structure

### Backend (api/src/)
- **Create:** `utils/audit.ts` — `logAudit()` helper function
- **Create:** `database/entities/AuditLog.ts` — AuditLog entity
- **Create:** `database/migrations/1774700000000-CreateAuditLog.ts` — audit_logs table migration
- **Modify:** `config/environment.ts` — add `AUDIT_RETENTION_DAYS` env var
- **Modify:** `routes/tenants.ts` — add deactivate, reactivate, pending-invites endpoints
- **Modify:** `routes/admin.routes.ts` — add audit log endpoints, enhance tenant detail, add API key rotate, wire logAudit calls
- **Modify:** `services/clerk-sync.service.ts` — already has `addMemberToClerkOrganization` (added earlier)
- **Modify:** `database/data-source.ts` — register AuditLog entity

### Frontend (portal/src/)
- **Create:** `pages/admin/AdminTenantDetail.tsx` — tenant detail page
- **Modify:** `pages/Team.tsx` — add pending invites section, fix member removal
- **Modify:** `pages/admin/AdminTenants.tsx` — tenant name links to detail page
- **Modify:** `App.tsx` — add `/admin/tenants/:id` route

---

## Task 1: Railway DB Connection

**Files:**
- Modify: `api/.env`

- [ ] **Step 1: Get Railway DATABASE_URL**

The user must provide their Railway Postgres connection string. It will look like:
```
postgresql://postgres:<password>@<host>.railway.app:5432/railway
```

- [ ] **Step 2: Update api/.env**

Replace the local DB config with the Railway DATABASE_URL:

```env
# Database (Railway)
DATABASE_URL=postgresql://postgres:<password>@<host>.railway.app:5432/railway
```

Remove these lines:
```env
DB_SYNC=true
DB_HOST=localhost
DB_PORT=5433
DB_NAME=chatbot_platform
DB_USER=postgres
DB_PASSWORD=
```

- [ ] **Step 3: Run migrations against Railway DB**

```bash
cd api && npx typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
```

Expected: All 4 existing migrations run successfully against Railway DB.

- [ ] **Step 4: Verify connection**

Start the API server and confirm it connects:
```bash
cd api && npm run dev
```

Expected: `Database connection established successfully` in logs.

- [ ] **Step 5: Commit**

```bash
git add api/.env.example
git commit -m "chore: document DATABASE_URL for Railway DB connection"
```

Note: Do NOT commit `api/.env` (it contains secrets). Only update `.env.example` to document the pattern.

---

## Task 2: Audit Log Entity + Migration + Helper

**Files:**
- Create: `api/src/database/entities/AuditLog.ts`
- Create: `api/src/database/migrations/1774700000000-CreateAuditLog.ts`
- Create: `api/src/utils/audit.ts`
- Modify: `api/src/database/data-source.ts`
- Modify: `api/src/config/environment.ts`

- [ ] **Step 1: Create AuditLog entity**

Create `api/src/database/entities/AuditLog.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('audit_logs')
@Index(['tenantId', 'createdAt'])
@Index(['actorId', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'tenant_id' })
  tenantId?: string;

  @Column({ type: 'uuid', name: 'actor_id' })
  actorId!: string;

  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'varchar', length: 50, name: 'entity_type' })
  entityType!: string;

  @Column({ type: 'uuid', name: 'entity_id' })
  entityId!: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
```

- [ ] **Step 2: Create migration**

Create `api/src/database/migrations/1774700000000-CreateAuditLog.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuditLog1774700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID,
        actor_id UUID NOT NULL,
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50) NOT NULL,
        entity_id UUID NOT NULL,
        metadata JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_audit_logs_tenant_created
      ON audit_logs (tenant_id, created_at DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_audit_logs_actor_created
      ON audit_logs (actor_id, created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS audit_logs`);
  }
}
```

- [ ] **Step 3: Create logAudit helper**

Create `api/src/utils/audit.ts`:

```typescript
import { AppDataSource } from '../database/data-source';
import { AuditLog } from '../database/entities/AuditLog';
import { logger } from './logger';

export async function logAudit(
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  tenantId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(AuditLog);
    await repo.insert({
      actorId,
      action,
      entityType,
      entityId,
      tenantId,
      metadata,
    });
  } catch (error) {
    logger.error('Failed to write audit log', { error, action, entityType, entityId });
  }
}
```

- [ ] **Step 4: Register entity in data-source.ts**

In `api/src/database/data-source.ts`, add to imports and entities array:

```typescript
import { AuditLog } from './entities/AuditLog';
```

Add `AuditLog` to the entities array after `PendingInvite`.

- [ ] **Step 5: Add AUDIT_RETENTION_DAYS to environment config**

In `api/src/config/environment.ts`, add to the Zod schema:

```typescript
AUDIT_RETENTION_DAYS: z.string().default('90').transform(Number),
```

And in the config object under a new `audit` key:

```typescript
audit: {
  retentionDays: env.AUDIT_RETENTION_DAYS,
},
```

- [ ] **Step 6: Run migration**

```bash
cd api && npx typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
```

Expected: `Migration CreateAuditLog1774700000000 has been executed successfully.`

- [ ] **Step 7: Commit**

```bash
git add api/src/database/entities/AuditLog.ts api/src/database/migrations/1774700000000-CreateAuditLog.ts api/src/utils/audit.ts api/src/database/data-source.ts api/src/config/environment.ts
git commit -m "feat: add audit_logs table, entity, and logAudit helper"
```

---

## Task 3: Wire Audit Logging into Existing Admin Routes

**Files:**
- Modify: `api/src/routes/admin.routes.ts`

- [ ] **Step 1: Import logAudit**

Add to top of `api/src/routes/admin.routes.ts`:

```typescript
import { logAudit } from '../utils/audit';
```

- [ ] **Step 2: Add logAudit calls to all existing mutation endpoints**

After each successful mutation, add a `logAudit` call. These are fire-and-forget (no await needed in response path, but we await to ensure order):

**POST /admin/tenants (create)** — after `await repo.save(tenant)` and before the invite step:
```typescript
await logAudit(req.userId!, 'tenant.created', 'tenant', tenant.id, tenant.id, { name, tier: tier || 'free' });
```

**PATCH /admin/tenants/:id (update)** — after `await repo.save(tenant)`:
```typescript
await logAudit(req.userId!, 'tenant.updated', 'tenant', tenant.id, tenant.id, { fields: Object.keys(req.body) });
```

**POST /admin/tenants/:id/suspend** — after saving:
```typescript
await logAudit(req.userId!, 'tenant.suspended', 'tenant', tenant.id, tenant.id);
```

**POST /admin/tenants/:id/activate** — after saving:
```typescript
await logAudit(req.userId!, 'tenant.activated', 'tenant', tenant.id, tenant.id);
```

**POST /admin/tenants/:id/invite** — after saving the PendingInvite:
```typescript
await logAudit(req.userId!, 'invite.sent', 'invite', invite.id, tenant.id, { email, role });
```

**POST /admin/users/:id/promote** — after saving:
```typescript
await logAudit(req.userId!, 'user.promoted', 'user', user.id, user.tenantId, { previousRole });
```

**POST /admin/users/:id/demote** — after saving:
```typescript
await logAudit(req.userId!, 'user.demoted', 'user', user.id, user.tenantId, { newRole: user.role });
```

**POST /admin/users/:id/reactivate** — after saving:
```typescript
await logAudit(req.userId!, 'user.reactivated', 'user', user.id, user.tenantId);
```

**PATCH /admin/users/:id (update)** — after saving (if role changed):
```typescript
if (role) {
  await logAudit(req.userId!, 'user.role_changed', 'user', user.id, user.tenantId, { previousRole: originalRole, newRole: role });
}
```

- [ ] **Step 3: Verify server starts without errors**

```bash
cd api && npm run dev
```

Expected: No import/type errors, server starts normally.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/admin.routes.ts
git commit -m "feat: wire audit logging into all admin mutation endpoints"
```

---

## Task 4: Audit Log Read Endpoints + Export + Cleanup

**Files:**
- Modify: `api/src/routes/admin.routes.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Add GET /admin/audit-logs endpoint**

Add to `api/src/routes/admin.routes.ts` (after the analytics section):

```typescript
// GET /admin/audit-logs — list audit logs with filters
router.get('/audit-logs', async (req: Request, res: Response) => {
  try {
    const params = parsePaginationParams(req.query as Record<string, unknown>);
    const qb = AppDataSource.getRepository(AuditLog)
      .createQueryBuilder('log')
      .leftJoin(User, 'actor', 'actor.id = log.actorId')
      .addSelect(['actor.name', 'actor.email']);

    const tenantId = req.query.tenantId as string;
    if (tenantId) {
      qb.andWhere('log.tenantId = :tenantId', { tenantId });
    }

    const action = req.query.action as string;
    if (action) {
      qb.andWhere('log.action = :action', { action });
    }

    const from = req.query.from as string;
    if (from) {
      qb.andWhere('log.createdAt >= :from', { from: new Date(from) });
    }

    const to = req.query.to as string;
    if (to) {
      qb.andWhere('log.createdAt <= :to', { to: new Date(to) });
    }

    qb.orderBy('log.createdAt', 'DESC');

    const result = await applyPagination(qb, params);

    // Resolve actor names with a separate query for simplicity
    const actorIds = [...new Set(result.data.map(l => l.actorId))];
    const actors = actorIds.length > 0
      ? await AppDataSource.getRepository(User)
          .createQueryBuilder('u')
          .select(['u.id', 'u.name', 'u.email'])
          .where('u.id IN (:...ids)', { ids: actorIds })
          .getMany()
      : [];
    const actorMap = new Map(actors.map(a => [a.id, { name: a.name, email: a.email }]));

    const data = result.data.map(log => ({
      id: log.id,
      tenantId: log.tenantId,
      actorId: log.actorId,
      actorName: actorMap.get(log.actorId)?.name ?? 'Unknown',
      actorEmail: actorMap.get(log.actorId)?.email ?? '',
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      metadata: log.metadata,
      createdAt: log.createdAt,
    }));

    return res.json({ success: true, data, meta: result.meta });
  } catch (error) {
    logger.error('Failed to list audit logs', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

Import `AuditLog` at the top:
```typescript
import { AuditLog } from '../database/entities/AuditLog';
```

- [ ] **Step 2: Add GET /admin/audit-logs/export endpoint**

```typescript
// GET /admin/audit-logs/export — CSV export
router.get('/audit-logs/export', async (req: Request, res: Response) => {
  try {
    const qb = AppDataSource.getRepository(AuditLog)
      .createQueryBuilder('log')
      .orderBy('log.createdAt', 'DESC');

    const tenantId = req.query.tenantId as string;
    if (tenantId) qb.andWhere('log.tenantId = :tenantId', { tenantId });

    const from = req.query.from as string;
    if (from) qb.andWhere('log.createdAt >= :from', { from: new Date(from) });

    const to = req.query.to as string;
    if (to) qb.andWhere('log.createdAt <= :to', { to: new Date(to) });

    const action = req.query.action as string;
    if (action) qb.andWhere('log.action = :action', { action });

    const logs = await qb.take(10000).getMany();

    const actorIds = [...new Set(logs.map(l => l.actorId))];
    const actors = actorIds.length > 0
      ? await AppDataSource.getRepository(User).createQueryBuilder('u')
          .select(['u.id', 'u.name', 'u.email'])
          .where('u.id IN (:...ids)', { ids: actorIds })
          .getMany()
      : [];
    const actorMap = new Map(actors.map(a => [a.id, a]));

    const header = 'timestamp,actor_name,actor_email,action,entity_type,entity_id,metadata\n';
    const rows = logs.map(l => {
      const actor = actorMap.get(l.actorId);
      const meta = l.metadata ? JSON.stringify(l.metadata).replace(/"/g, '""') : '';
      return `${l.createdAt.toISOString()},"${actor?.name ?? 'Unknown'}","${actor?.email ?? ''}",${l.action},${l.entityType},${l.entityId},"${meta}"`;
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=audit-logs-${new Date().toISOString().slice(0, 10)}.csv`);
    return res.send(header + rows);
  } catch (error) {
    logger.error('Failed to export audit logs', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

- [ ] **Step 3: Add audit retention cleanup on server startup**

In `api/src/server.ts`, after the database is initialized, add:

```typescript
import { config } from './config/environment';

// Audit log cleanup — runs once on startup, then daily
const cleanupAuditLogs = async () => {
  try {
    const result = await AppDataSource.query(
      `DELETE FROM audit_logs WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
      [config.audit.retentionDays]
    );
    logger.info('Audit log cleanup complete', { deletedCount: result?.[1] ?? 0 });
  } catch (error) {
    logger.error('Audit log cleanup failed', { error });
  }
};

// Run cleanup after 10 seconds, then every 24 hours
setTimeout(cleanupAuditLogs, 10_000);
setInterval(cleanupAuditLogs, 24 * 60 * 60 * 1000);
```

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/admin.routes.ts api/src/server.ts
git commit -m "feat: add audit log read endpoints, CSV export, and retention cleanup"
```

---

## Task 5: Member Deactivation + Reactivation Endpoints

**Files:**
- Modify: `api/src/routes/tenants.ts`

- [ ] **Step 1: Add imports**

Add to top of `api/src/routes/tenants.ts`:

```typescript
import { removeFromClerkOrganization, addMemberToClerkOrganization } from '../services/clerk-sync.service';
import { logAudit } from '../utils/audit';
```

- [ ] **Step 2: Add POST /tenants/me/users/:userId/deactivate**

Add after the existing `PATCH /tenants/me/users/:userId` route:

```typescript
/**
 * Deactivate a tenant member
 * POST /api/v1/tenants/me/users/:userId/deactivate
 */
router.post(
  '/me/users/:userId/deactivate',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { userId } = req.params;

    // Cannot deactivate yourself
    if (userId === req.userId) {
      return res.status(400).json({ error: 'Cannot deactivate yourself' });
    }

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: userId, tenantId } });

    if (!user) {
      return res.status(404).json({ error: 'User not found in this tenant' });
    }

    if (!user.isActive) {
      return res.status(400).json({ error: 'User is already deactivated' });
    }

    // Cannot deactivate the last active admin
    if (user.role === 'admin') {
      const activeAdminCount = await userRepo.count({
        where: { tenantId, role: 'admin' as const, isActive: true },
      });
      if (activeAdminCount <= 1) {
        return res.status(400).json({ error: 'Cannot deactivate the last active admin' });
      }
    }

    // Deactivate in DB
    user.isActive = false;
    await userRepo.save(user);

    // Remove from Clerk org + invalidate cache
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (user.clerkUserId && tenant?.clerkOrgId) {
      await removeFromClerkOrganization(tenant.clerkOrgId, user.clerkUserId);
      invalidateProvisionCache(tenant.clerkOrgId, user.clerkUserId);
    }

    await logAudit(req.userId!, 'user.deactivated', 'user', user.id, tenantId);

    logger.info('Deactivated user', { userId: user.id, tenantId, deactivatedBy: req.userId });
    return res.json({ success: true });
  })
);
```

- [ ] **Step 3: Add POST /tenants/me/users/:userId/reactivate**

```typescript
/**
 * Reactivate a tenant member
 * POST /api/v1/tenants/me/users/:userId/reactivate
 */
router.post(
  '/me/users/:userId/reactivate',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { userId } = req.params;

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: userId, tenantId } });

    if (!user) {
      return res.status(404).json({ error: 'User not found in this tenant' });
    }

    if (user.isActive) {
      return res.status(400).json({ error: 'User is already active' });
    }

    user.isActive = true;
    await userRepo.save(user);

    // Re-add to Clerk org
    if (user.clerkUserId) {
      const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
      if (tenant?.clerkOrgId) {
        await addMemberToClerkOrganization(tenant.clerkOrgId, user.clerkUserId, 'org:member');
      }
    }

    await logAudit(req.userId!, 'user.reactivated', 'user', user.id, tenantId);

    logger.info('Reactivated user', { userId: user.id, tenantId, reactivatedBy: req.userId });
    return res.json({ success: true });
  })
);
```

- [ ] **Step 4: Fix existing admin reactivate to use addMemberToClerkOrganization**

In `api/src/routes/admin.routes.ts`, update the `POST /admin/users/:id/reactivate` endpoint. Replace:

```typescript
await inviteToClerkOrganization(tenant.clerkOrgId, user.email, req.user?.clerkUserId);
```

With:

```typescript
await addMemberToClerkOrganization(tenant.clerkOrgId, user.clerkUserId!, 'org:member');
```

Note: `addMemberToClerkOrganization` should already be imported from an earlier change. If not, add it to the imports from `'../services/clerk-sync.service'`.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/tenants.ts api/src/routes/admin.routes.ts
git commit -m "feat: add member deactivate/reactivate endpoints with Clerk sync"
```

---

## Task 6: Pending Invites Endpoints

**Files:**
- Modify: `api/src/routes/tenants.ts`
- Modify: `api/src/routes/admin.routes.ts`

- [ ] **Step 1: Add tenant-level pending invites list**

Add to `api/src/routes/tenants.ts`:

```typescript
/**
 * List pending invites for current tenant
 * GET /api/v1/tenants/me/pending-invites
 */
router.get(
  '/me/pending-invites',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    const invites = await AppDataSource.getRepository(PendingInvite)
      .createQueryBuilder('invite')
      .leftJoin(User, 'inviter', 'inviter.id = invite.invitedBy')
      .addSelect(['inviter.name', 'inviter.email'])
      .where('invite.tenantId = :tenantId', { tenantId })
      .orderBy('invite.createdAt', 'DESC')
      .getMany();

    // Resolve inviter names
    const inviterIds = [...new Set(invites.map(i => i.invitedBy).filter(Boolean))] as string[];
    const inviters = inviterIds.length > 0
      ? await AppDataSource.getRepository(User)
          .createQueryBuilder('u')
          .select(['u.id', 'u.name', 'u.email'])
          .where('u.id IN (:...ids)', { ids: inviterIds })
          .getMany()
      : [];
    const inviterMap = new Map(inviters.map(u => [u.id, { name: u.name, email: u.email }]));

    const data = invites.map(inv => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      invitedBy: inv.invitedBy ? inviterMap.get(inv.invitedBy) ?? null : null,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      isExpired: new Date() > inv.expiresAt,
    }));

    return res.json({ success: true, data });
  })
);
```

- [ ] **Step 2: Add resend endpoint**

```typescript
/**
 * Resend a pending invite
 * POST /api/v1/tenants/me/pending-invites/:id/resend
 */
router.post(
  '/me/pending-invites/:id/resend',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const inviteRepo = AppDataSource.getRepository(PendingInvite);

    const invite = await inviteRepo.findOne({
      where: { id: req.params.id, tenantId },
    });

    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    // Re-send Clerk invitation
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant?.clerkOrgId) {
      return res.status(400).json({ error: 'Tenant has no Clerk organization linked' });
    }

    const sent = await inviteToClerkOrganization(tenant.clerkOrgId, invite.email, req.user?.clerkUserId);
    if (!sent) {
      return res.status(502).json({ error: 'Failed to resend Clerk invitation' });
    }

    // Reset expiry
    invite.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await inviteRepo.save(invite);

    await logAudit(req.userId!, 'invite.resent', 'invite', invite.id, tenantId, { email: invite.email });

    return res.json({ success: true, message: 'Invite resent' });
  })
);
```

- [ ] **Step 3: Add cancel/delete endpoint**

```typescript
/**
 * Cancel a pending invite
 * DELETE /api/v1/tenants/me/pending-invites/:id
 */
router.delete(
  '/me/pending-invites/:id',
  requireClerkAuth, autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const inviteRepo = AppDataSource.getRepository(PendingInvite);

    const invite = await inviteRepo.findOne({
      where: { id: req.params.id, tenantId },
    });

    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    await logAudit(req.userId!, 'invite.cancelled', 'invite', invite.id, tenantId, { email: invite.email });

    await inviteRepo.remove(invite);

    return res.json({ success: true, message: 'Invite cancelled' });
  })
);
```

- [ ] **Step 4: Add admin-level pending invites for tenant detail**

Add to `api/src/routes/admin.routes.ts`:

```typescript
// GET /admin/tenants/:id/pending-invites — list pending invites for a tenant
router.get('/tenants/:id/pending-invites', async (req: Request, res: Response) => {
  try {
    const tenantId = req.params.id;

    const invites = await AppDataSource.getRepository(PendingInvite)
      .find({ where: { tenantId }, order: { createdAt: 'DESC' } });

    const inviterIds = [...new Set(invites.map(i => i.invitedBy).filter(Boolean))] as string[];
    const inviters = inviterIds.length > 0
      ? await AppDataSource.getRepository(User)
          .createQueryBuilder('u')
          .select(['u.id', 'u.name', 'u.email'])
          .where('u.id IN (:...ids)', { ids: inviterIds })
          .getMany()
      : [];
    const inviterMap = new Map(inviters.map(u => [u.id, { name: u.name, email: u.email }]));

    const data = invites.map(inv => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      invitedBy: inv.invitedBy ? inviterMap.get(inv.invitedBy) ?? null : null,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      isExpired: new Date() > inv.expiresAt,
    }));

    return res.json({ success: true, data });
  } catch (error) {
    logger.error('Failed to list tenant pending invites', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

- [ ] **Step 5: Add audit log for invite.sent in tenants.ts**

In the existing `POST /tenants/me/invite` handler in `tenants.ts`, add after the PendingInvite is saved:

```typescript
await logAudit(req.userId!, 'invite.sent', 'invite', invite.id ?? 'unknown', tenantId, { email, role });
```

This requires capturing the invite ID from the upsert. Adjust the save to return the entity:

```typescript
const invite = inviteRepo.create({
  tenantId,
  email: email.toLowerCase(),
  role,
  invitedBy: req.userId!,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
});
const savedInvite = await inviteRepo.save(invite);
await logAudit(req.userId!, 'invite.sent', 'invite', savedInvite.id, tenantId, { email, role });
```

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/tenants.ts api/src/routes/admin.routes.ts
git commit -m "feat: add pending invites list, resend, cancel endpoints"
```

---

## Task 7: Team Page — Member Removal UI + Pending Invites Section

**Files:**
- Modify: `portal/src/pages/Team.tsx`

- [ ] **Step 1: Fix the confirmRemoveMember function**

In `OrgMembersPanel`, replace the existing `confirmRemoveMember` function:

```typescript
// Deactivate mutation
const deactivateMutation = useMutation({
  mutationFn: (userId: string) => api.post(`/tenants/me/users/${userId}/deactivate`),
  onSuccess: () => {
    toast.success('Member deactivated');
    queryClient.invalidateQueries({ queryKey: ['team-members'] });
    setRemoveMemberUserId(null);
  },
  onError: (error: unknown) => {
    const err = error as { response?: { data?: { error?: string } } };
    toast.error(err.response?.data?.error || 'Failed to deactivate member');
    setRemoveMemberUserId(null);
  },
});

// Reactivate mutation
const reactivateMutation = useMutation({
  mutationFn: (userId: string) => api.post(`/tenants/me/users/${userId}/reactivate`),
  onSuccess: () => {
    toast.success('Member reactivated');
    queryClient.invalidateQueries({ queryKey: ['team-members'] });
  },
  onError: (error: unknown) => {
    const err = error as { response?: { data?: { error?: string } } };
    toast.error(err.response?.data?.error || 'Failed to reactivate member');
  },
});

const confirmRemoveMember = () => {
  if (removeMemberUserId) {
    deactivateMutation.mutate(removeMemberUserId);
  }
};
```

- [ ] **Step 2: Update the members table to show inactive status + reactivate button**

In the members table row, after the role select cell, update the Actions cell:

```tsx
<TableCell>
  <div className="flex items-center gap-2">
    {!member.isActive ? (
      <Button
        size="sm"
        variant="outline"
        onClick={() => reactivateMutation.mutate(member.id)}
        disabled={reactivateMutation.isPending}
        className="text-status-online border-status-online/30 hover:bg-status-online/10"
      >
        Reactivate
      </Button>
    ) : (
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setRemoveMemberUserId(member.id)}
        className="hover:text-red-400 hover:bg-red-500/10"
        title="Deactivate member"
      >
        <Trash2 className="w-4 h-4" />
      </Button>
    )}
  </div>
</TableCell>
```

Add an inactive badge in the User cell if `!member.isActive`:

```tsx
{!member.isActive && (
  <Badge className="ml-2 bg-surface-3 text-text-muted border-edge text-xs">Inactive</Badge>
)}
```

- [ ] **Step 3: Add pending invites section**

Add a new interface and query at the top of `OrgMembersPanel`:

```typescript
interface PendingInviteItem {
  id: string;
  email: string;
  role: string;
  invitedBy: { name: string; email: string } | null;
  createdAt: string;
  expiresAt: string;
  isExpired: boolean;
}

// Inside OrgMembersPanel component:
const { data: invitesData } = useQuery({
  queryKey: ['pending-invites'],
  queryFn: () => api.get<{ success: boolean; data: PendingInviteItem[] }>('/tenants/me/pending-invites'),
});

const pendingInvites = invitesData?.data ?? [];

const resendMutation = useMutation({
  mutationFn: (inviteId: string) => api.post(`/tenants/me/pending-invites/${inviteId}/resend`),
  onSuccess: () => {
    toast.success('Invite resent');
    queryClient.invalidateQueries({ queryKey: ['pending-invites'] });
  },
  onError: () => toast.error('Failed to resend invite'),
});

const cancelInviteMutation = useMutation({
  mutationFn: (inviteId: string) => api.delete(`/tenants/me/pending-invites/${inviteId}`),
  onSuccess: () => {
    toast.success('Invite cancelled');
    queryClient.invalidateQueries({ queryKey: ['pending-invites'] });
  },
  onError: () => toast.error('Failed to cancel invite'),
});
```

Also update the invite mutation to invalidate pending-invites:

```typescript
onSuccess: () => {
  setInviteEmail('');
  setShowInviteForm(false);
  toast.success('Invitation sent successfully');
  queryClient.invalidateQueries({ queryKey: ['team-members'] });
  queryClient.invalidateQueries({ queryKey: ['pending-invites'] });
},
```

- [ ] **Step 4: Render pending invites table**

Add below the members Card, before the AlertDialog:

```tsx
{/* Pending Invites */}
{pendingInvites.length > 0 && (
  <Card variant="glass" className="overflow-hidden">
    <div className="px-6 py-4 border-b border-edge">
      <h3 className="font-semibold text-text-primary">
        Pending Invites <span className="text-text-muted font-normal">({pendingInvites.length})</span>
      </h3>
    </div>
    <Table>
      <TableHeader className="bg-surface-3">
        <TableRow>
          <TableHead className="text-xs font-medium text-text-secondary uppercase">Email</TableHead>
          <TableHead className="text-xs font-medium text-text-secondary uppercase">Role</TableHead>
          <TableHead className="text-xs font-medium text-text-secondary uppercase">Invited By</TableHead>
          <TableHead className="text-xs font-medium text-text-secondary uppercase">Expires</TableHead>
          <TableHead className="text-xs font-medium text-text-secondary uppercase">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pendingInvites.map((invite) => {
          const expiresDate = new Date(invite.expiresAt);
          const daysLeft = Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

          return (
            <TableRow key={invite.id}>
              <TableCell className="text-text-primary">{invite.email}</TableCell>
              <TableCell>
                <span className="capitalize text-text-secondary">{invite.role}</span>
              </TableCell>
              <TableCell className="text-text-secondary text-sm">
                {invite.invitedBy?.name ?? '—'}
              </TableCell>
              <TableCell>
                {invite.isExpired ? (
                  <Badge className="bg-status-busy/10 text-status-busy border-status-busy/20">Expired</Badge>
                ) : (
                  <span className="text-text-secondary text-sm">{daysLeft}d left</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resendMutation.mutate(invite.id)}
                    disabled={resendMutation.isPending}
                    className="text-xs"
                  >
                    Resend
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => cancelInviteMutation.mutate(invite.id)}
                    disabled={cancelInviteMutation.isPending}
                    className="text-xs hover:text-red-400 hover:bg-red-500/10"
                  >
                    Cancel
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  </Card>
)}
```

- [ ] **Step 5: Add api.delete to apiClient if not present**

Check if `api.delete` exists in the API client. If not, add it following the same pattern as `api.post`.

- [ ] **Step 6: Commit**

```bash
git add portal/src/pages/Team.tsx portal/src/services/apiClient.ts
git commit -m "feat: add member deactivation UI and pending invites section to Team page"
```

---

## Task 8: Enhanced Tenant Detail Backend

**Files:**
- Modify: `api/src/routes/admin.routes.ts`

- [ ] **Step 1: Enhance GET /admin/tenants/:id**

Replace the existing `GET /admin/tenants/:id` handler with an enhanced version that includes users, pending invites, and masked API key:

```typescript
// GET /admin/tenants/:id — tenant details with users, invites, API key
router.get('/tenants/:id', async (req: Request, res: Response) => {
  try {
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: req.params.id },
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const userRepo = AppDataSource.getRepository(User);
    const userCount = await userRepo.count({ where: { tenantId: tenant.id } });
    const users = await userRepo.find({
      where: { tenantId: tenant.id },
      order: { createdAt: 'DESC' },
      take: 10,
    });

    const sessionCount = await AppDataSource.getRepository(ChatSession).count({
      where: { tenantId: tenant.id },
    });

    const messageCount = await AppDataSource.getRepository(Message).count({
      where: { session: { tenantId: tenant.id } },
    });

    const pendingInvites = await AppDataSource.getRepository(PendingInvite).find({
      where: { tenantId: tenant.id },
      order: { createdAt: 'DESC' },
    });

    // Mask API key: show first 3 + last 4 chars
    const ak = tenant.apiKey;
    const apiKeyMasked = ak.length > 7
      ? `${ak.slice(0, 3)}${'*'.repeat(ak.length - 7)}${ak.slice(-4)}`
      : '****';

    const recentAuditLogs = await AppDataSource.getRepository(AuditLog)
      .find({
        where: { tenantId: tenant.id },
        order: { createdAt: 'DESC' },
        take: 20,
      });

    // Resolve actor names for audit logs
    const actorIds = [...new Set(recentAuditLogs.map(l => l.actorId))];
    const actors = actorIds.length > 0
      ? await userRepo.createQueryBuilder('u')
          .select(['u.id', 'u.name', 'u.email'])
          .where('u.id IN (:...ids)', { ids: actorIds })
          .getMany()
      : [];
    const actorMap = new Map(actors.map(a => [a.id, { name: a.name, email: a.email }]));

    return res.json({
      success: true,
      data: {
        ...tenant,
        apiKeyMasked,
        userCount,
        sessionCount,
        messageCount,
        users: users.map(u => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          isActive: u.isActive,
          lastLoginAt: u.lastLoginAt,
          createdAt: u.createdAt,
        })),
        pendingInvites: pendingInvites.map(inv => ({
          id: inv.id,
          email: inv.email,
          role: inv.role,
          createdAt: inv.createdAt,
          expiresAt: inv.expiresAt,
          isExpired: new Date() > inv.expiresAt,
        })),
        recentAuditLogs: recentAuditLogs.map(log => ({
          id: log.id,
          action: log.action,
          entityType: log.entityType,
          entityId: log.entityId,
          actorName: actorMap.get(log.actorId)?.name ?? 'Unknown',
          metadata: log.metadata,
          createdAt: log.createdAt,
        })),
      },
    });
  } catch (error) {
    logger.error('Failed to get tenant', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

Add `Message` import at the top if not present:
```typescript
import { Message } from '../database/entities/Message';
```

- [ ] **Step 2: Add POST /admin/tenants/:id/api-key/rotate**

```typescript
// POST /admin/tenants/:id/api-key/rotate — rotate API key for a tenant
router.post('/tenants/:id/api-key/rotate', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: req.params.id } });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    tenant.apiKey = `ak_${crypto.randomUUID().replace(/-/g, '')}`;
    await repo.save(tenant);

    await logAudit(req.userId!, 'apikey.rotated', 'tenant', tenant.id, tenant.id);

    return res.json({ success: true, data: { apiKey: tenant.apiKey } });
  } catch (error) {
    logger.error('Failed to rotate API key', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

- [ ] **Step 3: Add GET /admin/tenants/:id/audit-logs for filtered view**

```typescript
// GET /admin/tenants/:id/audit-logs — paginated audit logs for a tenant
router.get('/tenants/:id/audit-logs', async (req: Request, res: Response) => {
  try {
    const params = parsePaginationParams(req.query as Record<string, unknown>);
    const qb = AppDataSource.getRepository(AuditLog)
      .createQueryBuilder('log')
      .where('log.tenantId = :tenantId', { tenantId: req.params.id })
      .orderBy('log.createdAt', 'DESC');

    const result = await applyPagination(qb, params);

    const actorIds = [...new Set(result.data.map(l => l.actorId))];
    const actors = actorIds.length > 0
      ? await AppDataSource.getRepository(User).createQueryBuilder('u')
          .select(['u.id', 'u.name', 'u.email'])
          .where('u.id IN (:...ids)', { ids: actorIds })
          .getMany()
      : [];
    const actorMap = new Map(actors.map(a => [a.id, { name: a.name, email: a.email }]));

    const data = result.data.map(log => ({
      id: log.id,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      actorName: actorMap.get(log.actorId)?.name ?? 'Unknown',
      actorEmail: actorMap.get(log.actorId)?.email ?? '',
      metadata: log.metadata,
      createdAt: log.createdAt,
    }));

    return res.json({ success: true, data, meta: result.meta });
  } catch (error) {
    logger.error('Failed to list tenant audit logs', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/admin.routes.ts
git commit -m "feat: enhance tenant detail endpoint with users, invites, audit logs, API key"
```

---

## Task 9: Tenant Detail Frontend Page

**Files:**
- Create: `portal/src/pages/admin/AdminTenantDetail.tsx`
- Modify: `portal/src/App.tsx`
- Modify: `portal/src/pages/admin/AdminTenants.tsx`

- [ ] **Step 1: Create AdminTenantDetail.tsx**

Create `portal/src/pages/admin/AdminTenantDetail.tsx`. This page follows existing patterns from AdminTenants.tsx and AdminUsers.tsx — dark theme, Card variant="glass", Badge, Table components.

```tsx
/**
 * Admin Tenant Detail Page
 * Super admin view: tenant overview, members, invites, audit log.
 */

import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Loader2,
  ArrowLeft,
  Users,
  MessageSquare,
  Activity,
  Key,
  Eye,
  EyeOff,
  RotateCw,
  Send,
  X,
} from 'lucide-react';
import { api } from '@services/apiClient';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface TenantDetailData {
  id: string;
  name: string;
  slug: string;
  tier: string;
  status: string;
  apiKeyMasked: string;
  createdAt: string;
  userCount: number;
  sessionCount: number;
  messageCount: number;
  users: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    isActive: boolean;
    lastLoginAt: string | null;
    createdAt: string;
  }>;
  pendingInvites: Array<{
    id: string;
    email: string;
    role: string;
    createdAt: string;
    expiresAt: string;
    isExpired: boolean;
  }>;
  recentAuditLogs: Array<{
    id: string;
    action: string;
    entityType: string;
    entityId: string;
    actorName: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }>;
}

function tierBadgeClass(tier: string): string {
  switch (tier) {
    case 'enterprise': return 'bg-accent-500/10 text-accent-400 border-accent-500/20';
    case 'pro': return 'bg-primary-600/10 text-primary-400 border-primary-600/20';
    default: return 'bg-surface-3 text-text-muted border-edge';
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'active': return 'bg-status-online/10 text-status-online border-status-online/20';
    case 'suspended': return 'bg-status-busy/10 text-status-busy border-status-busy/20';
    default: return 'bg-surface-3 text-text-muted border-edge';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatAction(action: string): string {
  return action.replace(/\./g, ' ').replace(/_/g, ' ');
}

const AdminTenantDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [showApiKey, setShowApiKey] = useState(false);
  const [showRotateDialog, setShowRotateDialog] = useState(false);
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery<{ success: boolean; data: TenantDetailData }>({
    queryKey: ['admin', 'tenant-detail', id],
    queryFn: () => api.get(`/admin/tenants/${id}`),
    enabled: !!id,
  });

  // Audit logs with 30s auto-refetch
  const { data: auditData } = useQuery({
    queryKey: ['admin', 'tenant-audit', id],
    queryFn: () => api.get<{ success: boolean; data: TenantDetailData['recentAuditLogs']; meta: unknown }>(`/admin/tenants/${id}/audit-logs?limit=20`),
    enabled: !!id,
    refetchInterval: 30_000,
  });

  const suspendMutation = useMutation({
    mutationFn: () => api.post(`/admin/tenants/${id}/suspend`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'tenant-detail', id] });
      queryClient.invalidateQueries({ queryKey: ['admin-tenants-switcher'] });
      toast.success('Tenant suspended');
    },
    onError: () => toast.error('Failed to suspend tenant'),
  });

  const activateMutation = useMutation({
    mutationFn: () => api.post(`/admin/tenants/${id}/activate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'tenant-detail', id] });
      queryClient.invalidateQueries({ queryKey: ['admin-tenants-switcher'] });
      toast.success('Tenant activated');
    },
    onError: () => toast.error('Failed to activate tenant'),
  });

  const rotateMutation = useMutation({
    mutationFn: () => api.post<{ success: boolean; data: { apiKey: string } }>(`/admin/tenants/${id}/api-key/rotate`),
    onSuccess: (result) => {
      setRevealedApiKey(result.data.apiKey);
      setShowApiKey(true);
      queryClient.invalidateQueries({ queryKey: ['admin', 'tenant-detail', id] });
      toast.success('API key rotated');
      setShowRotateDialog(false);
    },
    onError: () => toast.error('Failed to rotate API key'),
  });

  const tenant = data?.data;
  const auditLogs = auditData?.data ?? tenant?.recentAuditLogs ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
      </div>
    );
  }

  if (isError || !tenant) {
    return (
      <div className="p-6">
        <p className="text-text-secondary">Failed to load tenant.</p>
        <Link to="/admin/tenants" className="text-primary-400 hover:underline mt-2 inline-block">
          Back to tenants
        </Link>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* Breadcrumb + Header */}
      <div>
        <Link to="/admin/tenants" className="flex items-center gap-1 text-sm text-text-muted hover:text-text-secondary mb-3">
          <ArrowLeft className="w-4 h-4" />
          All Tenants
        </Link>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-text-primary">{tenant.name}</h1>
            <Badge className={tierBadgeClass(tenant.tier)}>
              {tenant.tier.charAt(0).toUpperCase() + tenant.tier.slice(1)}
            </Badge>
            <Badge className={statusBadgeClass(tenant.status)}>
              {tenant.status.charAt(0).toUpperCase() + tenant.status.slice(1)}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            {tenant.status === 'active' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => suspendMutation.mutate()}
                disabled={suspendMutation.isPending}
                className="text-status-busy border-status-busy/30 hover:bg-status-busy/10"
              >
                Suspend
              </Button>
            ) : tenant.status === 'suspended' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => activateMutation.mutate()}
                disabled={activateMutation.isPending}
                className="text-status-online border-status-online/30 hover:bg-status-online/10"
              >
                Activate
              </Button>
            ) : null}
          </div>
        </div>
        <p className="text-text-muted text-sm mt-1">
          <span className="font-mono">{tenant.slug}</span> &middot; Created {formatDate(tenant.createdAt)}
        </p>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card variant="glass" className="p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary-600/10 flex items-center justify-center">
              <Users className="w-5 h-5 text-primary-400" />
            </div>
            <div>
              <p className="text-2xl font-bold font-mono text-text-primary">{tenant.userCount}</p>
              <p className="text-xs text-text-muted">Users</p>
            </div>
          </div>
        </Card>
        <Card variant="glass" className="p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-accent-500/10 flex items-center justify-center">
              <Activity className="w-5 h-5 text-accent-400" />
            </div>
            <div>
              <p className="text-2xl font-bold font-mono text-text-primary">{tenant.sessionCount}</p>
              <p className="text-xs text-text-muted">Sessions</p>
            </div>
          </div>
        </Card>
        <Card variant="glass" className="p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-status-online/10 flex items-center justify-center">
              <MessageSquare className="w-5 h-5 text-status-online" />
            </div>
            <div>
              <p className="text-2xl font-bold font-mono text-text-primary">{tenant.messageCount}</p>
              <p className="text-xs text-text-muted">Messages</p>
            </div>
          </div>
        </Card>
        <Card variant="glass" className="p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-surface-3 flex items-center justify-center">
              <Key className="w-5 h-5 text-text-muted" />
            </div>
            <div>
              <p className="text-sm font-mono text-text-secondary truncate max-w-[140px]">
                {showApiKey && revealedApiKey ? revealedApiKey : tenant.apiKeyMasked}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <button
                  onClick={() => { setShowApiKey(!showApiKey); if (!revealedApiKey) setShowApiKey(false); }}
                  className="text-xs text-text-muted hover:text-text-secondary"
                >
                  {showApiKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
                <button
                  onClick={() => setShowRotateDialog(true)}
                  className="text-xs text-text-muted hover:text-text-secondary"
                >
                  <RotateCw className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Members */}
      <Card variant="glass" className="overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge">
          <h3 className="font-semibold text-text-primary">
            Members <span className="text-text-muted font-normal">({tenant.userCount})</span>
          </h3>
          {tenant.userCount > 10 && (
            <Link
              to={`/admin/users?tenantId=${tenant.id}`}
              className="text-sm text-primary-400 hover:underline"
            >
              View all
            </Link>
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Login</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenant.users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium text-text-primary">{user.name}</TableCell>
                <TableCell className="text-text-secondary">{user.email}</TableCell>
                <TableCell>
                  <span className="capitalize text-text-secondary">{user.role.replace('_', ' ')}</span>
                </TableCell>
                <TableCell>
                  <Badge className={user.isActive
                    ? 'bg-status-online/10 text-status-online border-status-online/20'
                    : 'bg-surface-3 text-text-muted border-edge'
                  }>
                    {user.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </TableCell>
                <TableCell className="text-text-secondary text-sm">{formatDate(user.lastLoginAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Pending Invites */}
      {tenant.pendingInvites.length > 0 && (
        <Card variant="glass" className="overflow-hidden">
          <div className="px-6 py-4 border-b border-edge">
            <h3 className="font-semibold text-text-primary">
              Pending Invites <span className="text-text-muted font-normal">({tenant.pendingInvites.length})</span>
            </h3>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenant.pendingInvites.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="text-text-primary">{inv.email}</TableCell>
                  <TableCell className="capitalize text-text-secondary">{inv.role}</TableCell>
                  <TableCell className="text-text-secondary text-sm">{formatDate(inv.createdAt)}</TableCell>
                  <TableCell>
                    {inv.isExpired ? (
                      <Badge className="bg-status-busy/10 text-status-busy border-status-busy/20">Expired</Badge>
                    ) : (
                      <Badge className="bg-status-online/10 text-status-online border-status-online/20">Pending</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Audit Log */}
      <Card variant="glass" className="overflow-hidden">
        <div className="px-6 py-4 border-b border-edge">
          <h3 className="font-semibold text-text-primary">Recent Activity</h3>
        </div>
        {auditLogs.length === 0 ? (
          <div className="px-6 py-8 text-text-muted text-center text-sm">No activity recorded yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditLogs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-text-secondary text-sm whitespace-nowrap">
                    {formatTime(log.createdAt)}
                  </TableCell>
                  <TableCell className="text-text-primary text-sm">{log.actorName}</TableCell>
                  <TableCell>
                    <Badge className="bg-surface-3 text-text-secondary border-edge capitalize">
                      {formatAction(log.action)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-text-muted text-xs font-mono max-w-[200px] truncate">
                    {log.metadata ? JSON.stringify(log.metadata) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Rotate API Key Dialog */}
      <AlertDialog open={showRotateDialog} onOpenChange={(open) => !open && setShowRotateDialog(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate API Key</AlertDialogTitle>
            <AlertDialogDescription>
              This will invalidate the current API key immediately. Any integrations using it will break until updated with the new key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => rotateMutation.mutate()}
              className="bg-status-busy hover:bg-status-busy/90"
            >
              {rotateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Rotate Key'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AdminTenantDetail;
```

- [ ] **Step 2: Add route to App.tsx**

In `portal/src/App.tsx`, add import:

```typescript
import AdminTenantDetail from '@pages/admin/AdminTenantDetail';
```

Add route inside the `<SuperAdminRoute>` block, before the catch-all:

```tsx
<Route path="/admin/tenants/:id" element={<AdminTenantDetail />} />
```

- [ ] **Step 3: Make tenant names clickable in AdminTenants.tsx**

In `portal/src/pages/admin/AdminTenants.tsx`, add `Link` import:

```typescript
import { Link } from 'react-router-dom';
```

Replace the tenant name cell:

```tsx
<TableCell className="font-medium text-text-primary">{tenant.name}</TableCell>
```

With:

```tsx
<TableCell>
  <Link to={`/admin/tenants/${tenant.id}`} className="font-medium text-text-primary hover:text-primary-400 transition-colors">
    {tenant.name}
  </Link>
</TableCell>
```

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/admin/AdminTenantDetail.tsx portal/src/App.tsx portal/src/pages/admin/AdminTenants.tsx
git commit -m "feat: add tenant detail page with members, invites, audit log, API key management"
```

---

## Task 10: Final Verification

- [ ] **Step 1: Start API and portal**

```bash
cd api && npm run dev &
cd portal && npm run dev &
```

- [ ] **Step 2: Verify all flows work**

1. Navigate to `/admin/tenants` — tenant names should be clickable links
2. Click a tenant — detail page shows overview cards, members, invites, audit log
3. Navigate to `/team` — members tab shows deactivate button, pending invites section visible
4. Create a tenant with admin email — invite shows in pending invites
5. Perform admin actions (suspend, promote) — audit log entries appear in tenant detail

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: admin improvements — audit logging, member removal, pending invites, tenant detail"
```
