# Issue Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 6 improvements across two parallel tracks: data layer (#23 soft-delete, #20 pagination, #21 any cleanup) and infrastructure (#7 WebSocket rate limiting, #22 email verification, #19 tests).

**Architecture:** Two independent tracks that don't share files. Track 1 modifies entities, routes, types, and frontend. Track 2 modifies WebSocket handlers, middleware, and test infrastructure. Each task produces a working, committable unit.

**Tech Stack:** Express.js, TypeORM, PostgreSQL, Redis, Socket.io, React 18, React Query, Vitest, supertest

**Spec:** `docs/superpowers/specs/2026-03-25-issue-roadmap-design.md`

**Base path:** `chatbot-platform/` (all relative paths below are from this root)

---

## File Structure

### New files
- `api/src/utils/pagination.ts` — shared pagination helper
- `api/src/websocket/socket-rate-limit.ts` — per-event socket rate limiter factory
- `api/src/routes/clerk-webhook.routes.ts` — Clerk webhook handler for email verification
- `portal/src/components/ui/Pagination.tsx` — shared Pagination component
- `api/vitest.config.ts` — Vitest configuration
- `api/src/__tests__/setup.ts` — global test setup/teardown
- `api/src/__tests__/helpers/auth.ts` — mock auth helper
- `api/src/__tests__/integration/auth.test.ts` — auth route tests
- `api/src/__tests__/integration/chat.test.ts` — chat route tests
- `api/src/__tests__/unit/pagination.test.ts` — pagination unit tests
- `api/src/__tests__/unit/socket-rate-limit.test.ts` — rate limiter unit tests

### Modified files
- `api/src/database/entities/Participant.ts` — add soft-delete columns and methods
- `api/src/database/migrations/<timestamp>-AddParticipantSoftDelete.ts` — migration
- `api/src/routes/chat.routes.ts` — add participant DELETE endpoint
- `api/src/routes/widget.ts` — add `isDeleted: false` to participant queries
- `api/src/types/index.ts` — extend IApiMeta, add PaginatedResponse, replace `any` in Express augmentation
- `api/src/routes/agents.routes.ts` — apply pagination helper
- `api/src/routes/users.routes.ts` — apply pagination helper
- `api/src/routes/notifications.routes.ts` — apply pagination helper
- `api/src/routes/handsoff.routes.ts` — apply pagination helper
- `api/src/routes/tenants.ts` — apply pagination helper
- `portal/src/hooks/useChats.ts` — add pagination params and meta
- `api/src/websocket/socket.handler.ts` — wire per-event rate limiting, remove `as any` casts
- `api/src/middleware/clerk.middleware.ts` — add login-time email verification sync
- `api/src/config/environment.ts` — add CLERK_WEBHOOK_SECRET env var
- `api/src/server.ts` — register webhook route, export `app`
- `api/src/security/encryption.service.ts` — replace `any` types
- `api/src/security/xss-protection.ts` — replace `any` types
- `api/src/n8n/webhook.service.ts` — replace `any` types
- `api/src/n8n/outbound.service.ts` — replace `any` types
- `api/src/routes/handsoff.routes.ts` — replace `any` types
- `api/package.json` — add test dependencies and scripts

---

## Track 1: Data Layer Improvements

---

### Task 1: Participant Soft-Delete — Schema & Entity

**Files:**
- Modify: `api/src/database/entities/Participant.ts`
- Reference: `api/src/database/entities/Message.ts` (pattern to follow)

- [ ] **Step 1: Add isDeleted and deletedAt columns to Participant entity**

In `api/src/database/entities/Participant.ts`, add after the `updatedAt` column (line 89):

```typescript
@Column({ type: 'boolean', default: false, name: 'is_deleted' })
isDeleted!: boolean;

@Column({ type: 'timestamp', nullable: true, name: 'deleted_at' })
deletedAt?: Date;
```

- [ ] **Step 2: Add softDelete() method**

Add after the `isActive()` method (line 102):

```typescript
softDelete(): void {
  this.isDeleted = true;
  this.deletedAt = new Date();
  this.email = undefined;
  if (this.metadata) {
    const cleaned = { ...this.metadata };
    delete cleaned.ipAddress;
    delete cleaned.userAgent;
    delete cleaned.browser;
    delete cleaned.os;
    delete cleaned.device;
    delete cleaned.location;
    this.metadata = cleaned;
  }
}
```

Note: `email` is typed as `email?: string` (optional), so set it to `undefined` not `null`.

- [ ] **Step 3: Update isActive() to check isDeleted**

Change `isActive()` at line 100-102 from:

```typescript
isActive(): boolean {
  return !this.leftAt;
}
```

To:

```typescript
isActive(): boolean {
  return !this.leftAt && !this.isDeleted;
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`
Expected: No errors related to Participant entity changes.

- [ ] **Step 5: Commit**

```bash
git add api/src/database/entities/Participant.ts
git commit -m "feat(#23): add soft-delete columns and method to Participant entity"
```

---

### Task 2: Participant Soft-Delete — Migration

**Files:**
- Create: `api/src/database/migrations/<timestamp>-AddParticipantSoftDelete.ts`

Note: The `api/src/database/migrations/` directory does not exist yet. The TypeORM `data-source.ts` (line 43) expects migrations at `__dirname + '/migrations/*.ts'`. The `migration:create` command will create the directory.

- [ ] **Step 1: Generate the migration**

Run: `cd chatbot-platform/api && npx typeorm-ts-node-commonjs migration:create src/database/migrations/AddParticipantSoftDelete`

- [ ] **Step 2: Write the migration**

Edit the generated file:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddParticipantSoftDelete<timestamp> implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE participants
      ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN deleted_at TIMESTAMP NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_participants_active
      ON participants (session_id)
      WHERE is_deleted = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_participants_active`);
    await queryRunner.query(`
      ALTER TABLE participants
      DROP COLUMN IF EXISTS deleted_at,
      DROP COLUMN IF EXISTS is_deleted
    `);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add api/src/database/migrations/
git commit -m "feat(#23): add migration for participant soft-delete columns and index"
```

---

### Task 3: Participant Soft-Delete — Route & Query Filters

**Files:**
- Modify: `api/src/routes/chat.routes.ts` (add DELETE endpoint)
- Modify: `api/src/routes/widget.ts` (add `isDeleted: false` to participant lookups)

- [ ] **Step 1: Find all participant queries and add isDeleted filter**

Run: `cd chatbot-platform && rg 'participantRepository.find' api/src/ --glob '*.ts'`

This should find all participant lookups. For each one, add `isDeleted: false` to the `where` clause.

The known instance is in `api/src/routes/widget.ts` at line 284, which currently reads:

```typescript
let participant = await participantRepository.findOne({
  where: { sessionId, type: 'user' },
});
```

Update to:

```typescript
let participant = await participantRepository.findOne({
  where: { sessionId, type: 'user', isDeleted: false },
});
```

Apply the same filter to any other participant queries found by the grep.

- [ ] **Step 2: Add Participant import to chat.routes.ts**

In `api/src/routes/chat.routes.ts`, add:

```typescript
import { Participant } from '../database/entities/Participant';
```

- [ ] **Step 3: Add DELETE endpoint for participant soft-delete**

Add a new route in `api/src/routes/chat.routes.ts` after the existing routes:

```typescript
router.delete(
  '/:sessionId/participants/:participantId',
  requireClerkAuth, autoProvision,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { sessionId, participantId } = req.params;
      const authReq = req as AuthenticatedRequest;
      const tenantId = authReq.user?.tenantId;
      const participantRepo = AppDataSource.getRepository(Participant);

      const session = await sessionRepository.findOne({
        where: { id: sessionId, tenantId },
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const participant = await participantRepo.findOne({
        where: { id: participantId, sessionId, isDeleted: false },
      });

      if (!participant) {
        res.status(404).json({ error: 'Participant not found' });
        return;
      }

      participant.softDelete();
      await participantRepo.save(participant);

      res.status(200).json({ success: true, message: 'Participant deleted' });
    } catch (error) {
      logger.error('Failed to soft-delete participant', { error, sessionId: req.params.sessionId });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/chat.routes.ts api/src/routes/widget.ts
git commit -m "feat(#23): add participant soft-delete endpoint and query filters"
```

---

### Task 4: Pagination — Backend Helper

**Files:**
- Modify: `api/src/types/index.ts` (extend IApiMeta, add PaginatedResponse)
- Create: `api/src/utils/pagination.ts`

- [ ] **Step 1: Extend IApiMeta with hasMore**

In `api/src/types/index.ts`, update `IApiMeta` (line 319) to add `hasMore`:

```typescript
export interface IApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  hasMore?: boolean;
  timestamp: Date;
  requestId: string;
}
```

- [ ] **Step 2: Add PaginatedResponse type**

In `api/src/types/index.ts`, add after `IPaginationParams` (after line 333):

```typescript
export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
}
```

- [ ] **Step 3: Create pagination utility**

Create `api/src/utils/pagination.ts`:

```typescript
import { SelectQueryBuilder } from 'typeorm';

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMeta;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export interface ParsedPaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder: 'asc' | 'desc';
}

export function parsePaginationParams(query: Record<string, unknown>): ParsedPaginationParams {
  const page = query.page ? Math.max(1, parseInt(String(query.page))) : undefined;
  const offset = query.offset ? Math.max(0, parseInt(String(query.offset))) : undefined;
  const limit = Math.min(Math.max(1, parseInt(String(query.limit)) || DEFAULT_LIMIT), MAX_LIMIT);

  const resolvedPage = offset !== undefined ? Math.floor(offset / limit) + 1 : (page || 1);

  return {
    page: resolvedPage,
    limit,
    sortBy: query.sortBy ? String(query.sortBy) : undefined,
    sortOrder: query.sortOrder === 'asc' ? 'asc' : 'desc',
  };
}

export async function applyPagination<T>(
  queryBuilder: SelectQueryBuilder<T>,
  params: ParsedPaginationParams
): Promise<PaginatedResult<T>> {
  const page = params.page || 1;
  const limit = Math.min(params.limit || DEFAULT_LIMIT, MAX_LIMIT);

  if (params.sortBy) {
    const alias = queryBuilder.alias;
    queryBuilder.orderBy(`${alias}.${params.sortBy}`, params.sortOrder === 'asc' ? 'ASC' : 'DESC');
  }

  queryBuilder.skip((page - 1) * limit).take(limit);
  const [data, total] = await queryBuilder.getManyAndCount();
  const totalPages = Math.ceil(total / limit);

  return {
    data,
    meta: {
      page,
      limit,
      total,
      totalPages,
      hasMore: page < totalPages,
    },
  };
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add api/src/types/index.ts api/src/utils/pagination.ts
git commit -m "feat(#20): add pagination helper and extend IApiMeta type"
```

---

### Task 5: Pagination — Apply to Chat Sessions List

**Files:**
- Modify: `api/src/routes/chat.routes.ts` (the `GET /sessions` endpoint at line 320)

- [ ] **Step 1: Import pagination utilities**

Add to imports in `api/src/routes/chat.routes.ts`:

```typescript
import { parsePaginationParams, applyPagination } from '../utils/pagination';
```

- [ ] **Step 2: Refactor GET /sessions endpoint to use pagination helper**

The current endpoint (line 320-369) uses `findAndCount` with manual `take`/`skip` and `offset`-based response. Replace the handler body with:

```typescript
router.get(
  '/sessions',
  requireClerkAuth, autoProvision,
  validateTenant,
  async (req: TenantRequest, res: Response): Promise<void> => {
    try {
      const tenantId = req.tenant?.id;
      const status = req.query.status as string;
      const params = parsePaginationParams(req.query as Record<string, unknown>);

      const qb = sessionRepository
        .createQueryBuilder('session')
        .leftJoinAndSelect('session.assignedAgent', 'agent')
        .where('session.tenantId = :tenantId', { tenantId });

      if (status && ['active', 'closed', 'waiting', 'handoff'].includes(status)) {
        qb.andWhere('session.status = :status', { status });
      }

      if (!params.sortBy) {
        qb.orderBy('session.lastActivityAt', 'DESC');
      }

      const result = await applyPagination(qb, params);

      res.json({
        success: true,
        sessions: result.data.map((s) => ({
          id: s.id,
          status: s.status,
          assignedAgent: s.assignedAgent ? { id: s.assignedAgent.id } : null,
          lastActivityAt: s.lastActivityAt,
          createdAt: s.createdAt,
        })),
        meta: result.meta,
        pagination: {
          ...result.meta,
          offset: (result.meta.page - 1) * result.meta.limit,
        },
      });
    } catch (error) {
      logger.error('Error fetching sessions:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);
```

Note: The response includes both `meta` (new format) and `pagination` with `offset` (backward compat for existing consumers).

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/chat.routes.ts
git commit -m "feat(#20): apply pagination helper to chat sessions list"
```

---

### Task 6: Pagination — Apply to Remaining Routes

**Files:**
- Modify: `api/src/routes/agents.routes.ts`
- Modify: `api/src/routes/users.routes.ts`
- Modify: `api/src/routes/notifications.routes.ts`
- Modify: `api/src/routes/handsoff.routes.ts`
- Modify: `api/src/routes/tenants.ts`

For each file: read it first, identify the list endpoint, import `parsePaginationParams` and `applyPagination`, and refactor the existing offset/limit logic to use the shared helper. Follow the same pattern as Task 5:

1. Parse params with `parsePaginationParams(req.query)`
2. Build a query builder instead of `findAndCount`
3. Call `applyPagination(qb, params)`
4. Return response with `meta` object

- [ ] **Step 1: Apply pagination to agents list**

In `api/src/routes/agents.routes.ts`, import the pagination utilities. Find the GET list endpoint. Replace manual offset/limit logic with `parsePaginationParams` + `applyPagination`.

- [ ] **Step 2: Apply pagination to users list**

In `api/src/routes/users.routes.ts`, apply the same pattern. If no pagination exists currently, add it.

- [ ] **Step 3: Apply pagination to notifications list**

In `api/src/routes/notifications.routes.ts`, replace existing offset/limit logic with the shared helper.

- [ ] **Step 4: Apply pagination to handoffs list**

In `api/src/routes/handsoff.routes.ts`, replace any existing pagination logic with the shared helper.

- [ ] **Step 5: Apply pagination to tenants list**

In `api/src/routes/tenants.ts`, add pagination to the list endpoint using the shared helper.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add api/src/routes/agents.routes.ts api/src/routes/users.routes.ts api/src/routes/notifications.routes.ts api/src/routes/handsoff.routes.ts api/src/routes/tenants.ts
git commit -m "feat(#20): apply pagination helper to all remaining list routes"
```

---

### Task 7: Pagination — Frontend Component & Hook Updates

**Files:**
- Create: `portal/src/components/ui/Pagination.tsx`
- Modify: `portal/src/hooks/useChats.ts`

- [ ] **Step 1: Create shared Pagination component**

Create `portal/src/components/ui/Pagination.tsx`:

```tsx
import React from 'react';

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  isLoading?: boolean;
}

export function Pagination({ page, totalPages, onPageChange, isLoading }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1 || isLoading}
          className="px-3 py-1 text-sm border rounded-md disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent"
        >
          Previous
        </button>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages || isLoading}
          className="px-3 py-1 text-sm border rounded-md disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent"
        >
          Next
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update useChats hook to accept pagination params**

In `portal/src/hooks/useChats.ts`:

Update `UseChatsOptions` (line 13) to include pagination:

```typescript
interface UseChatsOptions {
  filters?: ChatFilters;
  autoRefresh?: boolean;
  refreshInterval?: number;
  page?: number;
  limit?: number;
}
```

Update `UseChatsReturn` (line 19) to expose pagination meta:

```typescript
interface UseChatsReturn {
  chats: Chat[];
  totalCount: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateFilters: (filters: Partial<ChatFilters>) => void;
  takeoverChat: (chatId: string) => Promise<void>;
  closeChat: (chatId: string) => Promise<void>;
  pagination: {
    page: number;
    totalPages: number;
    hasMore: boolean;
  };
}
```

Update the `fetchChats` callback (line 49) to pass `page` and `limit` as query params:

```typescript
if (options.page) params.append('page', String(options.page));
if (options.limit) params.append('limit', String(options.limit));
```

And parse the `meta` object from the response:

```typescript
const data = await api.get<any>(`/chats/sessions?${params.toString()}`);
setChats(data.sessions || data.data || []);
setTotalCount(data.meta?.total || data.pagination?.total || 0);
```

Add pagination state and return it:

```typescript
const paginationMeta = {
  page: data.meta?.page || 1,
  totalPages: data.meta?.totalPages || 1,
  hasMore: data.meta?.hasMore || false,
};
```

- [ ] **Step 3: Verify frontend compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/ui/Pagination.tsx portal/src/hooks/useChats.ts
git commit -m "feat(#20): add Pagination component and update useChats hook"
```

---

### Task 8: TypeScript `any` Cleanup — Batch 1 (Express Request Types)

**Files:**
- Modify: `api/src/types/index.ts` (lines 6-19, the `declare global` block)
- Reference: `api/src/middleware/auth.middleware.ts:14-22` (defines `AuthenticatedRequest.user` shape)
- Reference: `api/src/middleware/clerk.middleware.ts:18-33` (defines `ProvisionedRequest` shape)
- Reference: `api/src/middleware/clerk.middleware.ts:250-267` (`attachToRequest` — what actually goes on `req.user`)

The actual `req.user` shape set by both `auth.middleware.ts` (line 170) and `clerk.middleware.ts` (line 260) is:

```typescript
{ id: string; email: string; role: string; tenantId: string; type: 'agent' | 'widget' }
```

- [ ] **Step 1: Define typed interfaces for Express request extensions**

In `api/src/types/index.ts`, add before the `declare global` block (line 6):

```typescript
export interface RequestUser {
  id: string;
  email: string;
  role: string;
  tenantId: string;
  type: 'agent' | 'widget';
}

export interface RequestTenant {
  id: string;
  name: string;
  slug: string;
  apiKey: string;
  tier: TenantTier;
  status: TenantStatus;
  settings: ITenantSettings;
}

export interface RequestWidget {
  tenantId: string;
  sessionId?: string;
  visitorId?: string;
}

export interface RequestSession {
  id: string;
  tenantId: string;
  status: string;
}
```

Note: Before finalizing `RequestTenant`, read `api/src/middleware/tenant.middleware.ts` to verify the exact shape attached to `req.tenant`. Adjust to match.

- [ ] **Step 2: Replace any types in Express augmentation**

Update the `declare global` block (lines 6-19) to use the new interfaces:

```typescript
declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      userId?: string;
      requestId?: string;
      user?: RequestUser;
      tenant?: RequestTenant;
      widget?: RequestWidget;
      agentId?: string;
      session?: RequestSession;
    }
  }
}
```

- [ ] **Step 3: Fix downstream type errors**

Run `cd chatbot-platform/api && npx tsc --noEmit` and fix all resulting type errors in routes/middleware that previously relied on `any` for these properties. The `AuthenticatedRequest` interface in `auth.middleware.ts` (line 14) may now conflict — update it to use the shared `RequestUser` type, or remove its redundant `user` declaration.

- [ ] **Step 4: Commit**

```bash
git add api/src/types/index.ts api/src/middleware/ api/src/routes/
git commit -m "refactor(#21): replace any types in Express request augmentation (batch 1)"
```

---

### Task 9: TypeScript `any` Cleanup — Batch 2 (Socket Handler & Route as-any Casts)

**Files:**
- Modify: `api/src/websocket/socket.handler.ts`
- Modify: `api/src/routes/chat.routes.ts`

Note: `socket.handler.ts` already has properly typed interfaces for socket events (`MessageSendData`, `TypingIndicatorData`, `HandoffRequestData`, `HandoffResponseData` at lines 24-45). The `any` usage in this file is:
- Line 161: `io.use(validateSocketTenant as any)` — fix by typing the middleware parameter
- Line 344: `messageRepository.create({...} as any)` — fix by typing the create argument
- Line 346: `as unknown as Message` cast — fix by using proper generic

In `chat.routes.ts`, `as any` casts appear at:
- Line 124: `(req as any).user` — use `AuthenticatedRequest` instead
- Line 155: `messageRepository.create({...} as any)` — type the create argument
- Line 288: `messageRepository.create({...} as any)` — same pattern
- Line 553: `status: 'read' as any` — use `MessageStatus` type

- [ ] **Step 1: Fix socket.handler.ts `as any` casts**

Read the file. For line 161 (`validateSocketTenant as any`), check the actual signature of `validateSocketTenant` and align it. For the `messageRepository.create(... as any)` casts, provide the correct partial type that `create()` expects.

- [ ] **Step 2: Fix chat.routes.ts `as any` casts**

Replace `(req as any).user` with `(req as AuthenticatedRequest).user` (already imported). Replace `as any` on `messageRepository.create()` with a properly typed partial. Replace `status: 'read' as any` with the correct enum value or import `MessageStatus`.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/websocket/socket.handler.ts api/src/routes/chat.routes.ts
git commit -m "refactor(#21): remove as-any casts from socket handler and chat routes (batch 2)"
```

---

### Task 10: TypeScript `any` Cleanup — Batch 3 (Top Offenders)

**Files:**
- Modify: `api/src/security/encryption.service.ts` (14 `any` instances)
- Modify: `api/src/security/xss-protection.ts` (8 instances)
- Modify: `api/src/n8n/webhook.service.ts` (8 instances)
- Modify: `api/src/routes/handsoff.routes.ts` (7 instances)
- Modify: `api/src/n8n/outbound.service.ts` (6 instances)

- [ ] **Step 1: Fix encryption.service.ts**

Read the file, identify each `any` usage, determine the correct type from the runtime value, and replace. Common patterns: `catch (error: any)` → `catch (error: unknown)`, function params → specific types, crypto buffer types.

- [ ] **Step 2: Fix xss-protection.ts**

Same approach — replace `any` with `unknown`, `string`, or specific DOM/sanitizer types.

- [ ] **Step 3: Fix n8n service files**

In `webhook.service.ts` and `outbound.service.ts`, replace `any` with typed webhook payloads, response shapes, etc.

- [ ] **Step 4: Fix handsoff.routes.ts**

Replace `any` in route handler params and response objects.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add api/src/security/ api/src/n8n/ api/src/routes/handsoff.routes.ts
git commit -m "refactor(#21): replace any types in top offender files (batch 3)"
```

---

### Task 11: TypeScript `any` Cleanup — Batch 4 (Remaining)

**Files:**
- Modify: remaining files with `any` usage

Current `any` count by file (from grep):
- `config/redis.ts` (3) — `new Redis(connectionArg as any)`
- `middleware/clerk.middleware.ts` (2) — membership find callback
- `middleware/auth.middleware.ts` (2) — `expiresIn as any`
- `middleware/index.ts` (1)
- `routes/files.routes.ts` (1)
- `routes/analytics.routes.ts` (1)
- `routes/agents.routes.ts` (1)
- `routes/tenants.ts` (1)
- `n8n/index.ts` (5)
- `n8n/webhook.controller.ts` (4)
- `n8n/webhook.routes.ts` (5)
- `n8n/retry.service.ts` (1)
- `services/message-forwarding.service.ts` (3)
- `queue/message-queue.ts` (2)
- `file-handling/virus-scan.service.ts` (1)
- `file-handling/upload.controller.ts` (2)
- `file-handling/upload.service.ts` (1)
- `types/*.d.ts` (6) — type declarations, some `any` may be intentional

- [ ] **Step 1: Find all remaining `any` instances**

Run: `cd chatbot-platform/api && rg ': any|as any' src/ --glob '*.ts' -c | sort -t: -k2 -rn`

- [ ] **Step 2: Fix each file**

For each remaining file, replace `any` with the correct type. Use `unknown` for catch blocks, specific types for known values. For `.d.ts` files, leave intentional `any` in third-party type declarations.

- [ ] **Step 3: Verify zero any types remain (or document exceptions)**

Run: `cd chatbot-platform/api && npx tsc --noEmit`
Run the grep again to confirm count is 0 (or document intentional exceptions in `.d.ts` files).

- [ ] **Step 4: Commit**

```bash
git add api/src/
git commit -m "refactor(#21): eliminate remaining any types across codebase (batch 4)"
```

---

## Track 2: Infrastructure

---

### Task 12: WebSocket Rate Limiting — Per-Event Limiter Factory

**Files:**
- Create: `api/src/websocket/socket-rate-limit.ts`
- Reference: `api/src/middleware/rate-limit.middleware.ts` (existing `createRateLimiter` pattern at line 48)
- Reference: `api/src/config/redis.ts` (exports `getRedisClient`, `isRedisAvailable`)

- [ ] **Step 1: Create per-event rate limiter module**

Create `api/src/websocket/socket-rate-limit.ts`:

```typescript
import { RateLimiterRedis, RateLimiterMemory, RateLimiterAbstract } from 'rate-limiter-flexible';
import { getRedisClient, isRedisAvailable } from '../config/redis';
import { logger } from '../utils/logger';

interface EventRateConfig {
  points: number;
  windowSeconds: number;
}

const EVENT_RATE_CONFIGS: Record<string, EventRateConfig> = {
  'message:send': { points: 30, windowSeconds: 60 },
  'typing:indicator': { points: 60, windowSeconds: 60 },
  'file:upload': { points: 10, windowSeconds: 60 },
  'handoff:request': { points: 5, windowSeconds: 60 },
  'handoff:accept': { points: 10, windowSeconds: 60 },
  'handoff:reject': { points: 10, windowSeconds: 60 },
  'handoff:decline': { points: 10, windowSeconds: 60 },
  'session:join': { points: 20, windowSeconds: 60 },
  'session:leave': { points: 20, windowSeconds: 60 },
  'presence:update': { points: 30, windowSeconds: 60 },
  'agent:join': { points: 20, windowSeconds: 60 },
  'agent:leave': { points: 20, windowSeconds: 60 },
  'agent:status': { points: 20, windowSeconds: 60 },
  'message:read': { points: 60, windowSeconds: 60 },
};

const DEFAULT_CONFIG: EventRateConfig = { points: 100, windowSeconds: 60 };

const limiters = new Map<string, RateLimiterAbstract>();

function createLimiter(eventName: string): RateLimiterAbstract {
  const config = EVENT_RATE_CONFIGS[eventName] || DEFAULT_CONFIG;

  const client = getRedisClient();
  if (client && isRedisAvailable()) {
    return new RateLimiterRedis({
      storeClient: client,
      keyPrefix: `socket_rl_${eventName}`,
      points: config.points,
      duration: config.windowSeconds,
    });
  }

  logger.warn(`Redis unavailable for socket rate limiter (${eventName}), using memory fallback`);
  return new RateLimiterMemory({
    keyPrefix: `socket_rl_${eventName}`,
    points: config.points,
    duration: config.windowSeconds,
  });
}

function getLimiter(eventName: string): RateLimiterAbstract {
  if (!limiters.has(eventName)) {
    limiters.set(eventName, createLimiter(eventName));
  }
  return limiters.get(eventName)!;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

export async function checkEventRateLimit(
  socketId: string,
  tenantId: string,
  eventName: string
): Promise<RateLimitResult> {
  const limiter = getLimiter(eventName);
  const key = `${tenantId}:${socketId}`;

  try {
    await limiter.consume(key);
    return { allowed: true };
  } catch (rateLimiterRes: unknown) {
    const res = rateLimiterRes as { msBeforeNext?: number };
    const retryAfter = Math.ceil((res.msBeforeNext || 1000) / 1000);
    logger.warn('Socket rate limit exceeded', { socketId, tenantId, eventName, retryAfter });
    return { allowed: false, retryAfter };
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add api/src/websocket/socket-rate-limit.ts
git commit -m "feat(#7): add per-event socket rate limiter factory"
```

---

### Task 13: WebSocket Rate Limiting — Wire Into Socket Handlers

**Files:**
- Modify: `api/src/websocket/socket.handler.ts`

- [ ] **Step 1: Import the new rate limiter**

In `api/src/websocket/socket.handler.ts`, add:

```typescript
import { checkEventRateLimit } from './socket-rate-limit';
```

- [ ] **Step 2: Create a rate-limit wrapper for event handlers**

Add a helper function in `socket.handler.ts`:

```typescript
function withRateLimit(
  socket: TenantSocket,
  eventName: string,
  handler: (...args: unknown[]) => Promise<void> | void
) {
  socket.on(eventName, async (...args: unknown[]) => {
    const tenantId = socket.data.tenantId;
    if (!tenantId) return;

    const { allowed, retryAfter } = await checkEventRateLimit(
      socket.id,
      tenantId,
      eventName
    );
    if (!allowed) {
      socket.emit('error', { code: 'RATE_LIMITED', event: eventName, retryAfter });
      return;
    }
    await handler(...args);
  });
}
```

- [ ] **Step 3: Replace direct socket.on calls in setupEventHandlers with withRateLimit**

In `setupEventHandlers` (line 234), replace event registrations:

```typescript
function setupEventHandlers(socket: TenantSocket): void {
  withRateLimit(socket, 'message:send', (data) => handleMessageSend(socket, data as MessageSendData));
  withRateLimit(socket, 'message:read', (data) => handleMessageRead(socket, data as { messageId: string }));
  withRateLimit(socket, 'typing:indicator', (data) => handleTypingIndicator(socket, data as TypingIndicatorData));
  withRateLimit(socket, 'handoff:request', (data) => handleHandoffRequest(socket, data as HandoffRequestData));
  withRateLimit(socket, 'handoff:accept', (data) => handleHandoffAccept(socket, data as HandoffResponseData));
  withRateLimit(socket, 'handoff:reject', (data) => handleHandoffReject(socket, data as HandoffResponseData));
  withRateLimit(socket, 'session:join', (data) => handleSessionJoin(socket, data as { sessionId: string }));
  withRateLimit(socket, 'session:leave', (data) => handleSessionLeave(socket, data as { sessionId: string }));
  withRateLimit(socket, 'presence:update', (data) => handlePresenceUpdate(socket, data as { status: string }));
  withRateLimit(socket, 'agent:join', (data) => handleAgentJoin(socket, data as { sessionId: string }));
  withRateLimit(socket, 'agent:leave', (data) => handleAgentLeave(socket, data as { sessionId: string }));
  withRateLimit(socket, 'agent:status', (data) => handlePresenceUpdate(socket, data as { status: string }));
  withRateLimit(socket, 'handoff:decline', (data) => handleHandoffReject(socket, data as HandoffResponseData));
}
```

- [ ] **Step 4: Remove the old checkSocketRateLimit call from handleMessageSend**

In `handleMessageSend` (line 304), remove lines 307-311:

```typescript
// REMOVE these lines:
const allowed = await checkSocketRateLimit(socket.id, socket.data.tenantId);
if (!allowed) {
  socket.emit('error', { message: 'Rate limit exceeded' });
  return;
}
```

Also remove the import of `checkSocketRateLimit` from `'../middleware/rate-limit.middleware'` (line 13).

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add api/src/websocket/socket.handler.ts
git commit -m "feat(#7): wire per-event rate limiting into all socket handlers"
```

---

### Task 14: Email Verification — Clerk Webhook Handler

**Files:**
- Create: `api/src/routes/clerk-webhook.routes.ts`
- Modify: `api/src/server.ts` (register route before auth middleware)
- Modify: `api/src/config/environment.ts` (add CLERK_WEBHOOK_SECRET)

- [ ] **Step 1: Install svix for webhook verification**

Run: `cd chatbot-platform/api && npm install svix`

- [ ] **Step 2: Add CLERK_WEBHOOK_SECRET to env schema and config**

In `api/src/config/environment.ts`, add to `envSchema` (after `CLERK_SECRET_KEY` at line 111):

```typescript
CLERK_WEBHOOK_SECRET: z.string().optional(),
```

Add to the exported `config` object inside the `clerk` section (after line 279):

```typescript
clerk: {
  secretKey: env.CLERK_SECRET_KEY,
  webhookSecret: env.CLERK_WEBHOOK_SECRET,
},
```

- [ ] **Step 3: Create the Clerk webhook route**

Create `api/src/routes/clerk-webhook.routes.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { Webhook } from 'svix';
import { AppDataSource } from '../database/data-source';
import { User } from '../database/entities/User';
import { logger } from '../utils/logger';
import { config } from '../config/environment';

const router = Router();

interface ClerkEmailAddress {
  email_address: string;
  verification: { status: string };
}

interface ClerkUserEvent {
  type: string;
  data: {
    id: string;
    email_addresses: ClerkEmailAddress[];
    primary_email_address_id: string;
  };
}

router.post('/clerk', async (req: Request, res: Response): Promise<void> => {
  try {
    const webhookSecret = config.clerk.webhookSecret;
    if (!webhookSecret) {
      logger.error('CLERK_WEBHOOK_SECRET not configured');
      res.status(500).json({ error: 'Webhook not configured' });
      return;
    }

    const wh = new Webhook(webhookSecret);
    const payload = wh.verify(
      JSON.stringify(req.body),
      {
        'svix-id': req.headers['svix-id'] as string,
        'svix-timestamp': req.headers['svix-timestamp'] as string,
        'svix-signature': req.headers['svix-signature'] as string,
      }
    ) as ClerkUserEvent;

    if (payload.type !== 'user.created' && payload.type !== 'user.updated') {
      res.status(200).json({ received: true });
      return;
    }

    const { id: clerkUserId, email_addresses } = payload.data;
    const isVerified = email_addresses.some(
      (e) => e.verification?.status === 'verified'
    );

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { clerkUserId } });

    if (user && user.emailVerified !== isVerified) {
      user.emailVerified = isVerified;
      await userRepo.save(user);
      logger.info('Updated email verification status', { clerkUserId, emailVerified: isVerified });
    }

    res.status(200).json({ received: true });
  } catch (error) {
    logger.error('Clerk webhook processing failed', { error });
    res.status(400).json({ error: 'Webhook verification failed' });
  }
});

export default router;
```

- [ ] **Step 4: Register the route before auth middleware in server.ts**

In `api/src/server.ts`, add import after the existing route imports (line 32):

```typescript
import clerkWebhookRoutes from './routes/clerk-webhook.routes';
```

Register the webhook route BEFORE the `clerkMiddleware()` call (before line 95) and BEFORE `express.json()` (line 90), using `express.raw()` as its body parser so Svix can verify against the original raw bytes:

```typescript
app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }), clerkWebhookRoutes);
```

This ensures: (a) the route is not behind Clerk auth or tenant middleware, and (b) `req.body` is a raw `Buffer` for accurate webhook signature verification.

**Important:** Because this route uses `express.raw()` instead of `express.json()`, update the webhook handler in `clerk-webhook.routes.ts` to parse the raw body:

```typescript
const rawBody = req.body as Buffer;
const payload = wh.verify(
  rawBody.toString('utf8'),
  {
    'svix-id': req.headers['svix-id'] as string,
    'svix-timestamp': req.headers['svix-timestamp'] as string,
    'svix-signature': req.headers['svix-signature'] as string,
  }
) as ClerkUserEvent;
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/clerk-webhook.routes.ts api/src/config/environment.ts api/src/server.ts api/package.json api/package-lock.json
git commit -m "feat(#22): add Clerk webhook handler for email verification sync"
```

---

### Task 15: Email Verification — Login-Time Fallback Sync

**Files:**
- Modify: `api/src/middleware/clerk.middleware.ts` (the `autoProvision` function, line 86+)

The email verification sync should go in `autoProvision`, NOT `requireClerkAuth`. The `requireClerkAuth` function (line 64) only validates the Clerk auth state and returns early. The `autoProvision` function (line 86) is where the local User is resolved from `clerkUserId`.

- [ ] **Step 1: Add login-time email verification sync**

In `api/src/middleware/clerk.middleware.ts`, inside the `autoProvision` function, after the user is resolved (either from cache, existing lookup, or migration path), add the verification sync. The best place is after the user is resolved but before caching, around line 201 (after `user = existingByEmail` or after user creation):

After the `// --- Resolve User ---` section completes (around line 201), add:

```typescript
if (user && !user.emailVerified) {
  try {
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    const isVerified = clerkUser.emailAddresses?.some(
      (e: { verification?: { status: string } }) => e.verification?.status === 'verified'
    );
    if (isVerified) {
      user.emailVerified = true;
      await userRepo.save(user);
      logger.info('Synced email verification from Clerk on login', { clerkUserId });
    }
  } catch (err) {
    logger.warn('Failed to sync email verification from Clerk', { error: err });
  }
}
```

Note: `clerkClient` is already imported at line 8. The sync is non-blocking — auth continues even if the Clerk API call fails.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add api/src/middleware/clerk.middleware.ts
git commit -m "feat(#22): add login-time email verification fallback sync"
```

---

### Task 16: Test Infrastructure — Setup

**Files:**
- Modify: `api/src/server.ts` (export `app` for test imports)
- Create: `api/vitest.config.ts`
- Create: `api/src/__tests__/setup.ts`
- Create: `api/src/__tests__/helpers/auth.ts`
- Modify: `api/package.json` (add devDependencies and test script)

- [ ] **Step 1: Install test dependencies**

Run: `cd chatbot-platform/api && npm install -D vitest supertest @types/supertest`

- [ ] **Step 2: Export Express app from server.ts**

Currently `server.ts` only exports `httpServer` as default. Tests need the Express `app` instance directly (without starting the server). Add a named export at line 38 (after `const app = express();`):

At the bottom of `server.ts`, change:

```typescript
export default httpServer;
```

To:

```typescript
export { app };
export default httpServer;
```

- [ ] **Step 3: Create vitest config**

Create `api/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@config': path.resolve(__dirname, 'src/config'),
      '@middleware': path.resolve(__dirname, 'src/middleware'),
      '@routes': path.resolve(__dirname, 'src/routes'),
      '@websocket': path.resolve(__dirname, 'src/websocket'),
      '@utils': path.resolve(__dirname, 'src/utils'),
    },
  },
});
```

Note: The actual `tsconfig.json` maps `@models/*` → `src/models/*`, but no `src/models/` directory exists. Entities live in `src/database/entities/`. The aliases above match the real directory structure.

- [ ] **Step 4: Create test setup file**

Create `api/src/__tests__/setup.ts`.

**Critical:** `AppDataSource` reads its connection config from `DATABASE_URL` (via `config/environment.ts`). The setup must override `DATABASE_URL` with `TEST_DATABASE_URL` **before** importing `AppDataSource`, otherwise `synchronize(true)` will wipe the real database.

```typescript
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set for integration tests');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

import { AppDataSource } from '../database/data-source';
import { beforeAll, afterAll, afterEach } from 'vitest';

beforeAll(async () => {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
  await AppDataSource.synchronize(true);
});

afterEach(async () => {
  const entities = AppDataSource.entityMetadatas;
  for (const entity of entities) {
    const repository = AppDataSource.getRepository(entity.name);
    await repository.query(`TRUNCATE TABLE "${entity.tableName}" CASCADE`);
  }
});

afterAll(async () => {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
});
```

- [ ] **Step 5: Create auth test helper**

Create `api/src/__tests__/helpers/auth.ts`:

```typescript
import { Request, Response, NextFunction } from 'express';

export function mockClerkAuth(overrides: Partial<{ userId: string; tenantId: string; agentId: string }> = {}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.userId = overrides.userId || 'test-user-id';
    req.tenantId = overrides.tenantId || 'test-tenant-id';
    req.agentId = overrides.agentId || 'test-agent-id';
    req.user = {
      id: overrides.agentId || 'test-agent-id',
      email: 'test@example.com',
      role: 'admin',
      tenantId: overrides.tenantId || 'test-tenant-id',
      type: 'agent',
    };
    next();
  };
}
```

- [ ] **Step 6: Add test scripts to package.json**

In `api/package.json`, add to `"scripts"`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 7: Create test database and verify infrastructure works**

Create a test database locally (or use Docker Compose):

```bash
createdb chatbot_test
```

Or if using Docker:

```bash
docker exec -it <postgres-container> createdb -U postgres chatbot_test
```

Set the env var and run:

```bash
TEST_DATABASE_URL="postgresql://postgres:password@localhost:5433/chatbot_test" cd chatbot-platform/api && npx vitest run --passWithNoTests
```

Expected: Vitest runs successfully with 0 tests.

- [ ] **Step 8: Commit**

```bash
git add api/vitest.config.ts api/src/__tests__/ api/src/server.ts api/package.json api/package-lock.json
git commit -m "feat(#19): set up Vitest test infrastructure with auth helpers"
```

---

### Task 17: Tests — Integration Tests for Auth Routes

**Files:**
- Create: `api/src/__tests__/integration/auth.test.ts`
- Reference: `api/src/routes/auth.routes.ts` (read this first to understand actual endpoints)

- [ ] **Step 1: Read auth routes to understand actual endpoints**

Run: Read `api/src/routes/auth.routes.ts` to understand endpoint signatures, request bodies, and response shapes.

- [ ] **Step 2: Write auth route integration tests**

Create `api/src/__tests__/integration/auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Auth Routes', () => {
  describe('POST /api/v1/auth/login', () => {
    it('should return 401 for missing credentials', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({});

      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });
});
```

Note: Adjust endpoint paths, request bodies, and assertions to match the actual routes found in step 1.

- [ ] **Step 3: Run the tests**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/integration/auth.test.ts`

- [ ] **Step 4: Commit**

```bash
git add api/src/__tests__/integration/auth.test.ts
git commit -m "test(#19): add integration tests for auth routes"
```

---

### Task 18: Tests — Integration Tests for Chat Routes

**Files:**
- Create: `api/src/__tests__/integration/chat.test.ts`
- Reference: `api/src/routes/chat.routes.ts`

- [ ] **Step 1: Write chat route integration tests**

Create `api/src/__tests__/integration/chat.test.ts`. Test the key flows:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { ChatSession } from '../../database/entities/ChatSession';

describe('Chat Routes', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenantRepo = AppDataSource.getRepository(Tenant);
    const tenant = tenantRepo.create({
      name: 'Test Tenant',
      slug: 'test-tenant',
      apiKey: 'test-api-key-12345',
      tier: 'pro',
      status: 'active',
    });
    await tenantRepo.save(tenant);
    tenantId = tenant.id;
  });

  describe('GET /api/v1/chats/sessions', () => {
    it('should return paginated sessions', async () => {
      const sessionRepo = AppDataSource.getRepository(ChatSession);
      for (let i = 0; i < 25; i++) {
        await sessionRepo.save(sessionRepo.create({
          tenantId,
          visitorId: `visitor-${i}`,
          status: 'active',
          source: 'widget',
          startedAt: new Date(),
          lastActivityAt: new Date(),
        }));
      }

      // Note: This endpoint requires Clerk auth. For integration tests,
      // either mock the middleware or use the test auth helper.
      // Adjust based on how auth mocking is configured in setup.
    });
  });
});
```

Note: Read `chat.routes.ts` for exact response shapes. The sessions endpoint uses `requireClerkAuth` + `autoProvision`, so tests need auth mocking configured. Consider swapping the auth middleware in test mode or using supertest with a mock token.

- [ ] **Step 2: Run the tests**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/integration/chat.test.ts`

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/chat.test.ts
git commit -m "test(#19): add integration tests for chat routes (pagination + soft-delete)"
```

---

### Task 19: Tests — Unit Tests for Critical Utilities

**Files:**
- Create: `api/src/__tests__/unit/pagination.test.ts`
- Create: `api/src/__tests__/unit/socket-rate-limit.test.ts`

- [ ] **Step 1: Write pagination helper unit tests**

Create `api/src/__tests__/unit/pagination.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parsePaginationParams } from '../../utils/pagination';

describe('parsePaginationParams', () => {
  it('should return defaults for empty query', () => {
    const result = parsePaginationParams({});
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });

  it('should cap limit at 100', () => {
    const result = parsePaginationParams({ limit: '500' });
    expect(result.limit).toBe(100);
  });

  it('should convert offset to page', () => {
    const result = parsePaginationParams({ offset: '40', limit: '20' });
    expect(result.page).toBe(3);
  });

  it('should prefer offset over page when both provided', () => {
    const result = parsePaginationParams({ page: '5', offset: '0', limit: '20' });
    expect(result.page).toBe(1);
  });

  it('should handle negative values gracefully', () => {
    const result = parsePaginationParams({ page: '-1', limit: '-5' });
    expect(result.page).toBe(1);
    expect(result.limit).toBe(1);
  });

  it('should default sortOrder to desc', () => {
    const result = parsePaginationParams({});
    expect(result.sortOrder).toBe('desc');
  });

  it('should accept asc sortOrder', () => {
    const result = parsePaginationParams({ sortOrder: 'asc' });
    expect(result.sortOrder).toBe('asc');
  });
});
```

- [ ] **Step 2: Write socket rate limiter unit tests**

Create `api/src/__tests__/unit/socket-rate-limit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { checkEventRateLimit } from '../../websocket/socket-rate-limit';

describe('checkEventRateLimit', () => {
  it('should allow requests under the limit', async () => {
    const result = await checkEventRateLimit('socket-1', 'tenant-1', 'message:send');
    expect(result.allowed).toBe(true);
  });

  it('should block after exceeding limit', async () => {
    for (let i = 0; i < 30; i++) {
      await checkEventRateLimit('socket-flood', 'tenant-1', 'message:send');
    }
    const result = await checkEventRateLimit('socket-flood', 'tenant-1', 'message:send');
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('should use separate limits per event type', async () => {
    for (let i = 0; i < 30; i++) {
      await checkEventRateLimit('socket-multi', 'tenant-1', 'message:send');
    }
    const result = await checkEventRateLimit('socket-multi', 'tenant-1', 'typing:indicator');
    expect(result.allowed).toBe(true);
  });
});
```

- [ ] **Step 3: Run unit tests**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/unit/`

- [ ] **Step 4: Commit**

```bash
git add api/src/__tests__/unit/
git commit -m "test(#19): add unit tests for pagination and socket rate limiting"
```

---

## Execution Order

Tasks within each track are sequential. Tracks can run in parallel.

**Track 1 (Data Layer):**
Tasks 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11

**Track 2 (Infrastructure):**
Tasks 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19
