# Phase 1 Gap-Closing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out 6 remaining Phase 1 gaps: session cleanup on deactivation, super-admin invite management, audit log viewer improvements, and dialog text fix.

**Architecture:** All changes are within the existing Express API + React portal. One new utility file (`releaseAgentSessions.ts`), modifications to existing routes and portal pages, and a backwards-compatible change to the apiClient response interceptor.

**Tech Stack:** TypeScript, Express, TypeORM, React 18, TanStack React Query, shadcn/ui, Socket.io, Vitest + Supertest

---

### Task 1: Session Cleanup Helper

**Files:**
- Create: `api/src/utils/releaseAgentSessions.ts`

- [ ] **Step 1: Create the helper file**

```typescript
// api/src/utils/releaseAgentSessions.ts
import { EntityManager } from 'typeorm';
import { ChatSession } from '../database/entities/ChatSession';
import { HandoffRequest } from '../database/entities/HandoffRequest';
import { Agent } from '../database/entities/Agent';

interface ReleaseResult {
  releasedSessions: number;
  returnedHandoffs: number;
  affectedSessionIds: string[];
}

/**
 * Release all sessions and handoff requests assigned to an agent.
 * Must be called inside an active transaction (pass the EntityManager).
 * Socket events should be emitted by the caller AFTER the transaction commits.
 */
export async function releaseAgentSessions(
  userId: string,
  tenantId: string,
  manager: EntityManager,
): Promise<ReleaseResult> {
  // Resolve Agent from userId — user may be admin-only with no agent record
  const agent = await manager.findOne(Agent, { where: { userId, tenantId } });
  if (!agent) {
    return { releasedSessions: 0, returnedHandoffs: 0, affectedSessionIds: [] };
  }

  // 1. Find affected sessions
  const sessions = await manager
    .createQueryBuilder(ChatSession, 'cs')
    .select(['cs.id'])
    .where('cs.assigned_agent_id = :agentId', { agentId: agent.id })
    .andWhere('cs.status IN (:...statuses)', { statuses: ['active', 'handoff'] })
    .getMany();

  const affectedSessionIds = sessions.map(s => s.id);

  // 2. Null out agent + set status to waiting
  let releasedSessions = 0;
  if (affectedSessionIds.length > 0) {
    const result = await manager
      .createQueryBuilder()
      .update(ChatSession)
      .set({
        assignedAgentId: null as unknown as string | undefined,
        status: 'waiting' as const,
      })
      .where('assigned_agent_id = :agentId', { agentId: agent.id })
      .andWhere('status IN (:...statuses)', { statuses: ['active', 'handoff'] })
      .execute();
    releasedSessions = result.affected ?? 0;
  }

  // 3. Return accepted handoff requests to queue
  const handoffResult = await manager
    .createQueryBuilder()
    .update(HandoffRequest)
    .set({
      assignedAgentId: null as unknown as string | undefined,
      status: 'requested' as const,
    })
    .where('assigned_agent_id = :agentId', { agentId: agent.id })
    .andWhere('status = :status', { status: 'accepted' })
    .execute();

  return {
    releasedSessions,
    returnedHandoffs: handoffResult.affected ?? 0,
    affectedSessionIds,
  };
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd api && npx tsc --noEmit src/utils/releaseAgentSessions.ts 2>&1 | head -20`

If there are import path issues, fix them. The key imports are `EntityManager` from `typeorm`, and the three entities from `../database/entities/`.

- [ ] **Step 3: Commit**

```bash
git add api/src/utils/releaseAgentSessions.ts
git commit -m "feat(api): add releaseAgentSessions helper for session cleanup"
```

---

### Task 2: Wire Session Cleanup into Deactivation Endpoints

**Files:**
- Modify: `api/src/routes/admin.routes.ts` (deactivate endpoint ~line 498, delete endpoint ~line 637)
- Modify: `api/src/routes/tenants.ts` (deactivate endpoint ~line 575)

- [ ] **Step 1: Update super-admin deactivate endpoint**

In `api/src/routes/admin.routes.ts`, find the `POST /users/:id/deactivate` handler (~line 498). Add session cleanup after setting `isActive = false` but before the response. The endpoint currently doesn't use a transaction — wrap the core logic in one:

Add import at the top of the file:
```typescript
import { releaseAgentSessions } from '../utils/releaseAgentSessions';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';
```

Replace the section from `user.isActive = false;` through `sendSuccess(res, user);` with:

```typescript
  // Wrap in transaction for atomicity
  let releaseResult = { releasedSessions: 0, returnedHandoffs: 0, affectedSessionIds: [] as string[] };
  await AppDataSource.transaction(async (manager) => {
    user.isActive = false;
    await manager.save(User, user);
    releaseResult = await releaseAgentSessions(user.id, user.tenantId, manager);
  });

  // Fetch tenant once for Clerk removal + cache invalidation
  const tenant = user.clerkUserId
    ? await AppDataSource.getRepository(Tenant).findOne({ where: { id: user.tenantId } })
    : null;

  // Remove from Clerk org if applicable
  if (user.clerkUserId && tenant?.clerkOrgId) {
    const removed = await removeFromClerkOrganization(tenant.clerkOrgId, user.clerkUserId);
    if (!removed) {
      logger.warn('Failed to remove user from Clerk org — deactivated locally only', {
        userId: user.id, tenantId: tenant.id,
      });
    }
  }

  await logAudit(req.userId!, 'user.deactivated', 'user', user.id, user.tenantId, {
    releasedSessions: releaseResult.releasedSessions,
    returnedHandoffs: releaseResult.returnedHandoffs,
  });

  // Invalidate cache so changes take effect immediately
  if (user.clerkUserId && tenant?.clerkOrgId) {
    invalidateProvisionCache(tenant.clerkOrgId, user.clerkUserId);
  }

  // Socket events — after transaction committed
  for (const sessionId of releaseResult.affectedSessionIds) {
    emitToSession(user.tenantId, sessionId, 'agent:removed', {
      sessionId,
      reason: 'agent_deactivated',
    });
  }
  if (releaseResult.releasedSessions > 0 || releaseResult.returnedHandoffs > 0) {
    emitToTenantAgents(user.tenantId, 'handoff:queue_updated', {
      reason: 'agent_deactivated',
    });
  }

  logger.info('Deactivated user', { userId: user.id, deactivatedBy: req.userId });
  sendSuccess(res, user);
```

- [ ] **Step 2: Update tenant-level deactivate endpoint**

In `api/src/routes/tenants.ts`, find the `POST /me/users/:userId/deactivate` handler (~line 575). Add the same imports at the top of the file:

```typescript
import { releaseAgentSessions } from '../utils/releaseAgentSessions';
import { emitToSession, emitToTenantAgents } from '../websocket/socket.handler';
```

Replace the section from `// Deactivate in DB` through `res.json({ success: true });` with:

```typescript
    // Deactivate in DB + cleanup sessions in one transaction
    let releaseResult = { releasedSessions: 0, returnedHandoffs: 0, affectedSessionIds: [] as string[] };
    await AppDataSource.transaction(async (manager) => {
      user.isActive = false;
      await manager.save(User, user);
      releaseResult = await releaseAgentSessions(user.id, tenantId, manager);
    });

    // Remove from Clerk org + invalidate cache
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (user.clerkUserId && tenant?.clerkOrgId) {
      await removeFromClerkOrganization(tenant.clerkOrgId, user.clerkUserId);
      invalidateProvisionCache(tenant.clerkOrgId, user.clerkUserId);
    }

    await logAudit(req.userId!, 'user.deactivated', 'user', user.id, tenantId, {
      releasedSessions: releaseResult.releasedSessions,
      returnedHandoffs: releaseResult.returnedHandoffs,
    });

    // Socket events — after transaction committed
    for (const sessionId of releaseResult.affectedSessionIds) {
      emitToSession(tenantId, sessionId, 'agent:removed', {
        sessionId,
        reason: 'agent_deactivated',
      });
    }
    if (releaseResult.releasedSessions > 0 || releaseResult.returnedHandoffs > 0) {
      emitToTenantAgents(tenantId, 'handoff:queue_updated', {
        reason: 'agent_deactivated',
      });
    }

    logger.info('Deactivated user', { userId: user.id, tenantId, deactivatedBy: req.userId });
    res.json({ success: true });
```

- [ ] **Step 3: Refactor deletion endpoint to use the shared helper**

In `api/src/routes/admin.routes.ts`, find the `DELETE /admin/users/:id` handler (~line 637). Inside the transaction, replace the inline session/handoff cleanup (the two `createQueryBuilder().update()` blocks for ChatSession and HandoffRequest) with:

```typescript
      // 3. Release agent sessions + handoff requests
      if (agent) {
        await releaseAgentSessions(userId, tenantId!, manager);
      }
```

Keep everything else in the transaction (PII anonymization, agent soft-delete, pending invites cleanup) as-is.

- [ ] **Step 4: Verify compilation**

Run: `cd api && npx tsc --noEmit 2>&1 | head -30`
Expected: No errors (or only pre-existing ones unrelated to these changes).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/admin.routes.ts api/src/routes/tenants.ts
git commit -m "feat(api): wire session cleanup into deactivation endpoints"
```

---

### Task 3: Super-Admin Invite Resend/Cancel Endpoints

**Files:**
- Modify: `api/src/routes/admin.routes.ts`

- [ ] **Step 1: Add the resend endpoint**

In `api/src/routes/admin.routes.ts`, after the existing `GET /tenants/:id/pending-invites` handler (~line 95), add:

```typescript
// POST /admin/tenants/:id/pending-invites/:inviteId/resend
router.post('/tenants/:id/pending-invites/:inviteId/resend', asyncHandler(async (req: Request, res: Response) => {
  const { id: tenantId, inviteId } = req.params;

  const invite = await AppDataSource.getRepository(PendingInvite).findOne({
    where: { id: inviteId, tenantId },
  });
  if (!invite) throw new NotFoundError('Invite not found');

  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
  if (!tenant?.clerkOrgId) throw new BadRequestError('Tenant has no Clerk organization linked');

  const sent = await inviteToClerkOrganization(tenant.clerkOrgId, invite.email);
  if (!sent) {
    res.status(502).json({ error: 'Failed to resend Clerk invitation' });
    return;
  }

  invite.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await AppDataSource.getRepository(PendingInvite).save(invite);

  await logAudit(req.userId!, 'invite.resent', 'invite', invite.id, tenantId, { email: invite.email });

  logger.info('Super-admin resent invite', { inviteId, tenantId, resendBy: req.userId });
  sendSuccess(res, {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
  });
}));
```

Make sure `inviteToClerkOrganization` is imported at the top of the file:
```typescript
import { inviteToClerkOrganization } from '../services/clerk-sync.service';
```

- [ ] **Step 2: Add the cancel endpoint**

Immediately after the resend endpoint, add:

```typescript
// DELETE /admin/tenants/:id/pending-invites/:inviteId
router.delete('/tenants/:id/pending-invites/:inviteId', asyncHandler(async (req: Request, res: Response) => {
  const { id: tenantId, inviteId } = req.params;

  const inviteRepo = AppDataSource.getRepository(PendingInvite);
  const invite = await inviteRepo.findOne({ where: { id: inviteId, tenantId } });
  if (!invite) throw new NotFoundError('Invite not found');

  await logAudit(req.userId!, 'invite.cancelled', 'invite', invite.id, tenantId, { email: invite.email });
  await inviteRepo.remove(invite);

  logger.info('Super-admin cancelled invite', { inviteId, tenantId, cancelledBy: req.userId });
  res.status(204).send();
}));
```

- [ ] **Step 3: Verify compilation**

Run: `cd api && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/admin.routes.ts
git commit -m "feat(api): add super-admin invite resend/cancel endpoints"
```

---

### Task 4: Audit Log Backend Fixes (Tenant Name + Date Range)

**Files:**
- Modify: `api/src/routes/admin.routes.ts` (audit-logs endpoint ~line 751, export endpoint ~line 808)

- [ ] **Step 1: Add tenant name resolution to the audit logs list endpoint**

In `api/src/routes/admin.routes.ts`, find the `GET /audit-logs` handler (~line 751). After the query builder is created, add a left join on Tenant to get the name:

```typescript
  const qb = AppDataSource.getRepository(AuditLog)
    .createQueryBuilder('log')
    .leftJoin(Tenant, 'tenant', 'tenant.id = log.tenantId')
    .addSelect('tenant.name', 'tenantName');
```

Make sure `Tenant` is imported at the top (it likely already is).

Then update the response mapping — in the `data` mapping section, add `tenantName`. The query now returns raw results because of the `addSelect`, so we need to use `getRawAndEntities` or adjust. The simplest approach: after resolving actors, resolve tenant names the same way:

Actually, the cleaner approach is to batch-resolve tenant names like actor names are resolved. Replace the response mapping section with:

```typescript
  // Resolve actor names
  const actorIds = [...new Set(result.data.map(l => l.actorId))];
  const actors = actorIds.length > 0
    ? await AppDataSource.getRepository(User)
        .createQueryBuilder('u')
        .select(['u.id', 'u.name', 'u.email'])
        .where('u.id IN (:...ids)', { ids: actorIds })
        .getMany()
    : [];
  const actorMap = new Map(actors.map(a => [a.id, { name: a.name, email: a.email }]));

  // Resolve tenant names
  const tenantIds = [...new Set(result.data.map(l => l.tenantId).filter(Boolean))];
  const tenantNames = tenantIds.length > 0
    ? await AppDataSource.getRepository(Tenant)
        .createQueryBuilder('t')
        .select(['t.id', 't.name'])
        .where('t.id IN (:...ids)', { ids: tenantIds })
        .getMany()
    : [];
  const tenantMap = new Map(tenantNames.map(t => [t.id, t.name]));

  const data = result.data.map(log => ({
    id: log.id,
    tenantId: log.tenantId,
    tenantName: tenantMap.get(log.tenantId) ?? null,
    actorId: log.actorId,
    actorName: actorMap.get(log.actorId)?.name ?? 'Unknown',
    actorEmail: actorMap.get(log.actorId)?.email ?? '',
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    metadata: log.metadata,
    createdAt: log.createdAt,
  }));
```

Remove the earlier `leftJoin`/`addSelect` changes — the batch approach is cleaner and doesn't change the query builder shape.

- [ ] **Step 2: Fix date range end-of-day in the list endpoint**

In the same handler, find the `to` filter block:

```typescript
  const to = req.query.to as string;
  if (to) {
    qb.andWhere('log.createdAt <= :to', { to: new Date(to) });
  }
```

Replace with:

```typescript
  const to = req.query.to as string;
  if (to) {
    // Normalize to end-of-day: use exclusive next-day comparison
    const nextDay = new Date(to);
    nextDay.setDate(nextDay.getDate() + 1);
    qb.andWhere('log.createdAt < :toExclusive', { toExclusive: nextDay });
  }
```

- [ ] **Step 3: Fix the export endpoint (tenant name + date range)**

In the `GET /audit-logs/export` handler (~line 808), apply the same two fixes:

For date range, find:
```typescript
  const to = req.query.to as string;
  if (to) qb.andWhere('log.createdAt <= :to', { to: new Date(to) });
```

Replace with:
```typescript
  const to = req.query.to as string;
  if (to) {
    const nextDay = new Date(to);
    nextDay.setDate(nextDay.getDate() + 1);
    qb.andWhere('log.createdAt < :toExclusive', { toExclusive: nextDay });
  }
```

For tenant name resolution, after the `actorMap` is built, add:

```typescript
  const tenantIds = [...new Set(logs.map(l => l.tenantId).filter(Boolean))];
  const tenantEntities = tenantIds.length > 0
    ? await AppDataSource.getRepository(Tenant).createQueryBuilder('t')
        .select(['t.id', 't.name'])
        .where('t.id IN (:...ids)', { ids: tenantIds })
        .getMany()
    : [];
  const tenantMap = new Map(tenantEntities.map(t => [t.id, t.name]));
```

Update the CSV header and row format:
```typescript
  const header = 'timestamp,actor_name,actor_email,tenant_name,action,entity_type,entity_id,metadata\n';
  const rows = logs.map(l => {
    const actor = actorMap.get(l.actorId);
    const tName = tenantMap.get(l.tenantId) ?? '';
    const meta = l.metadata ? JSON.stringify(l.metadata).replace(/"/g, '""') : '';
    return `${l.createdAt.toISOString()},"${actor?.name ?? 'Unknown'}","${actor?.email ?? ''}","${tName}",${l.action},${l.entityType},${l.entityId},"${meta}"`;
  }).join('\n');
```

- [ ] **Step 4: Verify compilation**

Run: `cd api && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/admin.routes.ts
git commit -m "fix(api): add tenant name to audit logs, fix date range end-of-day"
```

---

### Task 5: Portal apiClient Meta Preservation

**Files:**
- Modify: `portal/src/services/apiClient.ts`

- [ ] **Step 1: Update the response interceptor**

In `portal/src/services/apiClient.ts`, find the response interceptor (~line 47). Replace:

```typescript
  (response) => {
    // If the response has our standard envelope, unwrap it
    if (response.data && typeof response.data === 'object' && 'success' in response.data && 'data' in response.data) {
      response.data = response.data.data;
    }
    return response;
  },
```

With:

```typescript
  (response) => {
    // If the response has our standard envelope, unwrap it
    if (response.data && typeof response.data === 'object' && 'success' in response.data && 'data' in response.data) {
      if ('meta' in response.data && response.data.meta) {
        // Preserve pagination metadata alongside data
        response.data = { data: response.data.data, meta: response.data.meta };
      } else {
        response.data = response.data.data;
      }
    }
    return response;
  },
```

- [ ] **Step 2: Verify the portal compiles**

Run: `cd portal && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add portal/src/services/apiClient.ts
git commit -m "fix(portal): preserve pagination meta in apiClient response interceptor"
```

---

### Task 6: Audit Log Viewer — Filters, Export, Pagination

**Files:**
- Modify: `portal/src/pages/admin/AdminAuditLogs.tsx`
- Modify: `portal/src/queries/useAdminQueries.ts`

- [ ] **Step 1: Update useAdminAuditLogs to support pagination metadata**

In `portal/src/queries/useAdminQueries.ts`, replace the `useAdminAuditLogs` function (~line 55):

```typescript
interface AuditLogResponse {
  data: unknown[];
  meta?: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean };
}

export function useAdminAuditLogs(params?: Record<string, unknown>) {
  return useQuery({
    queryKey: [...queryKeys.admin.auditLogs(), params],
    queryFn: async () => {
      const result = await api.get<AuditLogResponse>('/admin/audit-logs', { params });
      // When meta is present, apiClient returns { data, meta }
      if (result && typeof result === 'object' && 'meta' in result) {
        return result as AuditLogResponse;
      }
      // Fallback: no meta (shouldn't happen after apiClient fix)
      return { data: result as unknown[] };
    },
  });
}
```

- [ ] **Step 2: Add the tenant list override for the dropdown**

In the same file, update `useAdminTenants` to fetch all tenants (not capped at 20):

```typescript
export function useAdminTenants() {
  return useQuery({
    ...adminOptions.tenants(),
    queryFn: () => api.get<Any[]>('/admin/tenants', { params: { limit: 1000 } }),
  });
}
```

- [ ] **Step 3: Add CSV export helper**

In the same file, add after the mutations section:

```typescript
export async function downloadAuditLogsCsv(params: Record<string, string>) {
  const response = await apiClient.get('/admin/audit-logs/export', {
    params,
    responseType: 'blob',
  });
  const url = window.URL.createObjectURL(new Blob([response.data as BlobPart]));
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}
```

Also add `apiClient` to the imports at the top (`apiClient` is the default export):
```typescript
import apiClient, { api } from '../services/apiClient';
```

Note: `api` is a named export, `apiClient` is the default export from `apiClient.ts`.

- [ ] **Step 4: Rewrite AdminAuditLogs.tsx with filters, export, and pagination**

Replace the entire content of `portal/src/pages/admin/AdminAuditLogs.tsx` with:

```typescript
/**
 * Admin Audit Logs Page
 * Super admin view: platform-wide audit log with filters, export, and pagination.
 */

import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useAdminTenants, useAdminAuditLogs, downloadAuditLogsCsv } from '../../queries/useAdminQueries';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/Pagination';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ACTION_OPTIONS = [
  'user.deactivated',
  'user.reactivated',
  'user.role_changed',
  'user.deleted',
  'user.promoted',
  'user.demoted',
  'invite.sent',
  'invite.resent',
  'invite.cancelled',
  'tenant.created',
  'tenant.updated',
  'tenant.suspended',
  'tenant.activated',
  'apikey.rotated',
] as const;

const PAGE_SIZE = 25;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorName: string;
  tenantName?: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface AdminTenant {
  id: string;
  name: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatAction(action: string): string {
  return action.replace(/\./g, ' ').replace(/_/g, ' ');
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const AdminAuditLogs: React.FC = () => {
  const [tenantId, setTenantId] = useState<string>('all');
  const [action, setAction] = useState<string>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);
  const [isExporting, setIsExporting] = useState(false);

  /* ---- Data ---- */
  const { data: tenantsData, isLoading: isLoadingTenants } = useAdminTenants();
  const tenants = (tenantsData as AdminTenant[] | undefined) ?? [];

  const params: Record<string, unknown> = { page, limit: PAGE_SIZE };
  if (tenantId !== 'all') params.tenantId = tenantId;
  if (action !== 'all') params.action = action;
  if (fromDate) params.from = fromDate;
  if (toDate) params.to = toDate;

  const { data: response, isLoading, isError } = useAdminAuditLogs(params);
  const logs = ((response as { data?: AuditLog[] })?.data ?? response ?? []) as AuditLog[];
  const meta = (response as { meta?: { totalPages: number; total: number } })?.meta;

  /* ---- Filter change resets page ---- */
  const handleFilterChange = <T,>(setter: React.Dispatch<React.SetStateAction<T>>) => (value: T) => {
    setter(value);
    setPage(1);
  };

  /* ---- Export ---- */
  const handleExport = async () => {
    setIsExporting(true);
    try {
      const exportParams: Record<string, string> = {};
      if (tenantId !== 'all') exportParams.tenantId = tenantId;
      if (action !== 'all') exportParams.action = action;
      if (fromDate) exportParams.from = fromDate;
      if (toDate) exportParams.to = toDate;
      await downloadAuditLogsCsv(exportParams);
    } finally {
      setIsExporting(false);
    }
  };

  /* ---- Render ---- */
  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Audit Logs</h1>
          <p className="text-text-secondary mt-1">Platform-wide activity log across all tenants.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={isExporting || isLoading}
        >
          <Download className="w-4 h-4 mr-2" />
          {isExporting ? 'Exporting...' : 'Download CSV'}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <Select
          value={tenantId}
          onValueChange={handleFilterChange(setTenantId)}
          disabled={isLoadingTenants}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All Tenants" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tenants</SelectItem>
            {tenants.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={action}
          onValueChange={handleFilterChange(setAction)}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All Actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Actions</SelectItem>
            {ACTION_OPTIONS.map((a) => (
              <SelectItem key={a} value={a}>
                {formatAction(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={fromDate}
          onChange={(e) => handleFilterChange(setFromDate)(e.target.value)}
          className="w-[160px]"
          placeholder="From"
        />
        <Input
          type="date"
          value={toDate}
          onChange={(e) => handleFilterChange(setToDate)(e.target.value)}
          className="w-[160px]"
          placeholder="To"
        />
      </div>

      {/* Table */}
      <Card variant="glass" className="overflow-hidden">
        <CardContent className="p-0">
          {isLoading ? (
            <PageSkeleton variant="table" rows={8} />
          ) : isError ? (
            <div className="p-6 text-text-secondary">Failed to load audit logs.</div>
          ) : logs.length === 0 ? (
            <div className="p-6 text-text-muted text-center">No audit logs found.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-text-secondary text-sm whitespace-nowrap">
                      {formatTime(log.createdAt)}
                    </TableCell>
                    <TableCell className="text-text-primary text-sm">{log.actorName}</TableCell>
                    <TableCell className="text-text-secondary text-sm">
                      {log.tenantName ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge className="bg-surface-3 text-text-secondary border-edge capitalize">
                        {formatAction(log.action)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-text-secondary text-sm">
                      <span className="capitalize">{log.entityType}</span>
                    </TableCell>
                    <TableCell className="text-text-muted text-xs font-mono max-w-[200px] truncate">
                      {log.metadata ? JSON.stringify(log.metadata) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {meta && (
        <Pagination
          page={page}
          totalPages={meta.totalPages}
          onPageChange={setPage}
          isLoading={isLoading}
        />
      )}

      {/* Footer count */}
      {!isLoading && !isError && meta && (
        <p className="text-sm text-text-muted mt-1">
          {meta.total} total log{meta.total !== 1 ? 's' : ''}
        </p>
      )}
    </div>
  );
};

export default AdminAuditLogs;
```

- [ ] **Step 5: Verify the portal compiles**

Run: `cd portal && npx tsc --noEmit 2>&1 | head -30`
Expected: No errors. If there are import issues (e.g., `apiClient` not exported), fix them.

- [ ] **Step 6: Commit**

```bash
git add portal/src/pages/admin/AdminAuditLogs.tsx portal/src/queries/useAdminQueries.ts
git commit -m "feat(portal): audit log filters, CSV export, and pagination"
```

---

### Task 7: Super-Admin Invite Management UI

**Files:**
- Modify: `portal/src/pages/admin/AdminTenantDetail.tsx`
- Modify: `portal/src/queries/useAdminQueries.ts`

- [ ] **Step 1: Add mutation hooks in useAdminQueries.ts**

In `portal/src/queries/useAdminQueries.ts`, add after the existing mutations:

```typescript
export function useAdminResendInvite(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) =>
      api.post(`/admin/tenants/${tenantId}/pending-invites/${inviteId}/resend`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantDetail(tenantId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantAudit(tenantId) });
      toast.success('Invite resent');
    },
    onError: () => toast.error('Failed to resend invite'),
  });
}

export function useAdminCancelInvite(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) =>
      api.delete(`/admin/tenants/${tenantId}/pending-invites/${inviteId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantDetail(tenantId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenantAudit(tenantId) });
      toast.success('Invite cancelled');
    },
    onError: () => toast.error('Failed to cancel invite'),
  });
}
```

- [ ] **Step 2: Add action buttons to AdminTenantDetail invite rows**

In `portal/src/pages/admin/AdminTenantDetail.tsx`, find the pending invites table (~line 329). Add imports at the top:

```typescript
import { RotateCw, X } from 'lucide-react';
import { useAdminResendInvite, useAdminCancelInvite } from '../../queries/useAdminQueries';
```

Inside the component, add the hooks (use the tenant ID from the route param):

```typescript
  const resendInvite = useAdminResendInvite(id!);
  const cancelInvite = useAdminCancelInvite(id!);
```

Then update the invite table to add an Actions column. Find the `<TableHeader>` in the pending invites section and add a column:

```typescript
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
```

And add the action buttons in each row, after the Status `<TableCell>`:

```typescript
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => resendInvite.mutate(inv.id)}
                        disabled={resendInvite.isPending}
                        title="Resend invite"
                      >
                        <RotateCw className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => cancelInvite.mutate(inv.id)}
                        disabled={cancelInvite.isPending}
                        title="Cancel invite"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
```

Make sure `Button` is imported from `@/components/ui/button`.

- [ ] **Step 3: Verify the portal compiles**

Run: `cd portal && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/admin/AdminTenantDetail.tsx portal/src/queries/useAdminQueries.ts
git commit -m "feat(portal): add invite resend/cancel buttons to AdminTenantDetail"
```

---

### Task 8: Dialog Text Fix

**Files:**
- Modify: `portal/src/pages/Team.tsx`

- [ ] **Step 1: Fix the deactivation dialog text**

In `portal/src/pages/Team.tsx`, find the AlertDialog (~line 759). Replace:

```typescript
            <AlertDialogTitle>Remove Member</AlertDialogTitle>
            <AlertDialogDescription>
              Remove this member from the organization? This action cannot be undone.
            </AlertDialogDescription>
```

With:

```typescript
            <AlertDialogTitle>Deactivate Member</AlertDialogTitle>
            <AlertDialogDescription>
              Deactivate this member? They will lose access to the organization. You can reactivate them later.
            </AlertDialogDescription>
```

And find the confirm button:

```typescript
            <AlertDialogAction onClick={(e) => { e.preventDefault(); confirmRemoveMember(); }}>Remove</AlertDialogAction>
```

Replace with:

```typescript
            <AlertDialogAction onClick={(e) => { e.preventDefault(); confirmRemoveMember(); }}>Deactivate</AlertDialogAction>
```

- [ ] **Step 2: Commit**

```bash
git add portal/src/pages/Team.tsx
git commit -m "fix(portal): update deactivation dialog to reflect reversible action"
```

---

### Task 9: Auth-Rejection Tests for New Endpoints

**Files:**
- Modify: `api/src/__tests__/integration/admin.test.ts`

- [ ] **Step 1: Add auth-rejection tests for the new endpoints**

In `api/src/__tests__/integration/admin.test.ts`, add inside the existing `describe('Admin Routes')` block:

```typescript
  describe('POST /api/v1/admin/tenants/:id/pending-invites/:inviteId/resend', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).post(
        '/api/v1/admin/tenants/00000000-0000-0000-0000-000000000000/pending-invites/00000000-0000-0000-0000-000000000001/resend',
      );
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/admin/tenants/:id/pending-invites/:inviteId', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).delete(
        '/api/v1/admin/tenants/00000000-0000-0000-0000-000000000000/pending-invites/00000000-0000-0000-0000-000000000001',
      );
      expect(res.status).toBe(401);
    });
  });
```

- [ ] **Step 2: Run the tests**

Run: `cd api && npx vitest run src/__tests__/integration/admin.test.ts 2>&1`
Expected: All tests pass (existing + new).

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/admin.test.ts
git commit -m "test(api): add auth-rejection tests for invite resend/cancel endpoints"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Run full API test suite**

Run: `cd api && npx vitest run 2>&1`
Expected: All tests pass.

- [ ] **Step 2: Run portal type check**

Run: `cd portal && npx tsc --noEmit 2>&1`
Expected: No errors.

- [ ] **Step 3: Run portal build**

Run: `cd portal && npm run build 2>&1`
Expected: Build succeeds.
