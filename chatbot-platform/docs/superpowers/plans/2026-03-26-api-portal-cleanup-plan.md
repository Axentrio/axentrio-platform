# API Consistency & TanStack Query Best Practices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize API error handling, validation, and response format; refactor all Portal data fetching to TanStack Query v5 best practices with centralized query layer.

**Status:** Completed (2026-03-26) — All 14 tasks implemented across commits `66710ea`..`d9c9c33`.

**Architecture:** Two workstreams — API consistency pass (Tasks 1-5) and Portal query refactor (Tasks 6-14). **Critical ordering:** Task 4 (portal apiClient envelope unwrap) MUST be completed before Task 5 (route conversion), per the spec's migration strategy. After that, Workstream B (Tasks 6-14) can proceed independently.

**Tech Stack:** Express + TypeScript + Zod (API), React + TanStack Query v5 + Axios + Socket.IO (Portal)

**Spec:** `docs/superpowers/specs/2026-03-26-api-portal-cleanup-design.md`

---

## Workstream A: API Consistency Pass

### Task 1: Request ID Middleware

**Files:**
- Create: `api/src/middleware/request-id.middleware.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Create the request ID middleware**

```ts
// api/src/middleware/request-id.middleware.ts
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  req.requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}
```

- [ ] **Step 2: Register middleware in server.ts**

In `api/src/server.ts`, add import and register BEFORE helmet (so all subsequent middleware/routes have the ID):

```ts
// Add import at top:
import { requestIdMiddleware } from './middleware/request-id.middleware';
```

Register after the health check but before helmet — insert at the line before `app.use(helmet(...))`:

```ts
// Request ID — must come before all other middleware
app.use(requestIdMiddleware);
```

- [ ] **Step 3: Verify API compiles**

Run: `/opt/homebrew/bin/npm run build --prefix api`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add api/src/middleware/request-id.middleware.ts api/src/server.ts
git commit -m "feat(api): add request ID middleware for request tracing"
```

---

### Task 2: Response Wrapper Utility

**Files:**
- Create: `api/src/utils/response.ts`

- [ ] **Step 1: Create the response helper**

```ts
// api/src/utils/response.ts
import { Response } from 'express';

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function sendSuccess<T>(res: Response, data: T, meta?: Record<string, unknown>): void {
  res.json({ success: true, data, ...(meta && { meta }) });
}

export function sendPaginated<T>(res: Response, data: T[], pagination: PaginationMeta): void {
  res.json({
    success: true,
    data,
    meta: { pagination },
  });
}

export function sendCreated<T>(res: Response, data: T): void {
  res.status(201).json({ success: true, data });
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}
```

- [ ] **Step 2: Verify API compiles**

Run: `/opt/homebrew/bin/npm run build --prefix api`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add api/src/utils/response.ts
git commit -m "feat(api): add response wrapper utilities for consistent envelope"
```

---

### Task 3: Zod Validation Middleware + Schemas

**Files:**
- Create: `api/src/middleware/validate.ts`
- Create: `api/src/schemas/agent.schema.ts`
- Create: `api/src/schemas/tenant.schema.ts`
- Create: `api/src/schemas/chat.schema.ts`
- Create: `api/src/schemas/auth.schema.ts`
- Create: `api/src/schemas/handoff.schema.ts`
- Create: `api/src/schemas/webhook.schema.ts`
- Create: `api/src/schemas/admin.schema.ts`
- Create: `api/src/schemas/analytics.schema.ts`
- Create: `api/src/schemas/user.schema.ts`
- Create: `api/src/schemas/index.ts`

- [ ] **Step 1: Verify Zod is installed**

Zod is already in `api/package.json` (`"zod": "^3.22.4"`). Verify with: `grep zod api/package.json`. If missing, run `/opt/homebrew/bin/npm install zod --prefix api`.

- [ ] **Step 2: Create the validate middleware**

```ts
// api/src/middleware/validate.ts
import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ValidationError } from './error-handler';

type Source = 'body' | 'query' | 'params';

export function validate(schema: ZodSchema, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      throw new ValidationError('Validation failed', result.error.flatten() as unknown as Record<string, unknown>);
    }
    (req as Record<string, unknown>)[source] = result.data;
    next();
  };
}
```

- [ ] **Step 3: Create schema files**

Read each route file to identify all validated fields and create corresponding Zod schemas. Each schema file follows this pattern:

```ts
// api/src/schemas/agent.schema.ts
import { z } from 'zod';

export const createAgentSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  maxConcurrentChats: z.number().int().positive().optional(),
  skills: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
});

export const updateAgentSchema = z.object({
  maxConcurrentChats: z.number().int().positive().optional(),
  skills: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

export const updateAgentStatusSchema = z.object({
  status: z.enum(['online', 'away', 'busy', 'offline']),
});
```

```ts
// api/src/schemas/auth.schema.ts
import { z } from 'zod';

export const widgetAuthSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
```

```ts
// api/src/schemas/chat.schema.ts
import { z } from 'zod';

export const sendMessageSchema = z.object({
  content: z.string().min(1, 'Message content is required'),
  type: z.enum(['text', 'image', 'file', 'system']).default('text'),
  metadata: z.record(z.unknown()).optional(),
});

export const chatListQuerySchema = z.object({
  status: z.enum(['active', 'closed', 'waiting', 'handoff']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
```

```ts
// api/src/schemas/tenant.schema.ts
import { z } from 'zod';

export const updateTenantSchema = z.object({
  name: z.string().min(1).optional(),
  webhookUrl: z.string().url().optional().or(z.literal('')),
  settings: z.record(z.unknown()).optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().email('Valid email is required'),
  name: z.string().min(1, 'Name is required'),
  role: z.enum(['admin', 'supervisor', 'agent']),
});
```

```ts
// api/src/schemas/handoff.schema.ts
import { z } from 'zod';

export const requestHandoffSchema = z.object({
  sessionId: z.string().min(1, 'Session ID is required'),
  reason: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});
```

```ts
// api/src/schemas/webhook.schema.ts
import { z } from 'zod';

export const webhookConfigSchema = z.object({
  url: z.string().url('Webhook URL must be a valid URL'),
  secret: z.string().optional(),
  events: z.array(z.string()).optional(),
});
```

```ts
// api/src/schemas/admin.schema.ts
import { z } from 'zod';

export const createTenantSchema = z.object({
  name: z.string().min(1, 'Tenant name is required'),
  slug: z.string().min(1, 'Slug is required'),
  tier: z.enum(['free', 'starter', 'professional', 'enterprise']).default('free'),
  ownerEmail: z.string().email('Valid owner email is required'),
  ownerName: z.string().min(1, 'Owner name is required'),
});

export const updateUserRoleSchema = z.object({
  role: z.enum(['admin', 'supervisor', 'agent']),
});

export const adminUpdateUserSchema = z.object({
  role: z.enum(['admin', 'supervisor', 'agent']).optional(),
  isActive: z.boolean().optional(),
});
```

```ts
// api/src/schemas/analytics.schema.ts
import { z } from 'zod';

export const analyticsQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});
```

```ts
// api/src/schemas/user.schema.ts
import { z } from 'zod';

export const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  avatar: z.string().url().optional(),
});
```

```ts
// api/src/schemas/index.ts
export * from './agent.schema';
export * from './auth.schema';
export * from './chat.schema';
export * from './tenant.schema';
export * from './handoff.schema';
export * from './webhook.schema';
export * from './admin.schema';
export * from './analytics.schema';
export * from './user.schema';
```

- [ ] **Step 4: Verify API compiles**

Run: `/opt/homebrew/bin/npm run build --prefix api`
Expected: Clean compilation

- [ ] **Step 5: Commit**

```bash
git add api/src/middleware/validate.ts api/src/schemas/
git commit -m "feat(api): add Zod validation middleware and request schemas"
```

---

### Task 4: Update Portal apiClient for New Response Envelope

**Files:**
- Modify: `portal/src/services/apiClient.ts`

The API will soon wrap responses in `{ success: true, data: ... }`. The portal's API client methods currently return `res.data` from Axios. We need to add an interceptor that unwraps the new envelope BEFORE converting the routes (per spec migration strategy).

- [ ] **Step 1: Update apiClient response interceptor**

In `portal/src/services/apiClient.ts`, add a response interceptor that handles the new envelope:

```ts
// Add response interceptor to unwrap { success, data } envelope
axiosInstance.interceptors.response.use(
  (response) => {
    // If the response has our standard envelope, unwrap it
    if (response.data && typeof response.data === 'object' && 'success' in response.data && 'data' in response.data) {
      response.data = response.data.data;
    }
    return response;
  },
  (error) => {
    // existing error handling stays as-is
    return Promise.reject(error);
  }
);
```

This makes the migration seamless — old-format responses pass through unchanged, new-format responses get unwrapped.

Also search for any double-unwrap patterns like `api.get(...).then(res => res.data)` in page files (e.g., `LiveMonitor.tsx` does this). Remove the extra `.then(res => res.data)` since `api.get` already returns `res.data`.

- [ ] **Step 2: Verify portal compiles**

Run: `/opt/homebrew/bin/npm run build --prefix portal`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add portal/src/services/apiClient.ts portal/src/pages/LiveMonitor.tsx
git commit -m "feat(portal): update apiClient to unwrap new response envelope"
```

---

### Task 5: Convert All Route Files to asyncHandler + Error Classes + sendSuccess

This is the largest API task. Convert all 12 route files from manual error responses to throwing typed error classes, wrap handlers in `asyncHandler`, and use `sendSuccess`/`sendPaginated` for responses. Add `validate()` middleware where schemas apply.

**Files:**
- Modify: `api/src/routes/agents.routes.ts`
- Modify: `api/src/routes/analytics.routes.ts`
- Modify: `api/src/routes/auth.routes.ts`
- Modify: `api/src/routes/chat.routes.ts`
- Modify: `api/src/routes/clerk-webhook.routes.ts`
- Modify: `api/src/routes/files.routes.ts`
- Modify: `api/src/routes/handsoff.routes.ts`
- Modify: `api/src/routes/notifications.routes.ts`
- Modify: `api/src/routes/users.routes.ts`
- Modify: `api/src/routes/webhook-admin.routes.ts`
- Modify: `api/src/routes/widget.ts`
- Modify: `api/src/routes/admin.routes.ts`

**The conversion pattern for each route file is:**

1. Add imports:
```ts
import { asyncHandler, BadRequestError, NotFoundError, ForbiddenError, ConflictError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess, sendPaginated, sendCreated } from '../utils/response';
// Import relevant schemas
```

2. For each handler, apply three changes:

**Before:**
```ts
router.get('/path', middleware1, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!someField) {
      res.status(400).json({ error: 'someField is required' });
      return;
    }
    const result = await doSomething();
    if (!result) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

**After:**
```ts
router.get('/path', middleware1, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (!someField) throw new BadRequestError('someField is required');
  const result = await doSomething();
  if (!result) throw new NotFoundError('Not found');
  sendSuccess(res, result);
}));
```

- [ ] **Step 1: Convert agents.routes.ts**

Read `api/src/routes/agents.routes.ts` fully. Apply the conversion pattern:
- Add imports for `asyncHandler`, error classes, `sendSuccess`, `sendCreated`, `validate`
- Import `createAgentSchema`, `updateAgentSchema`, `updateAgentStatusSchema` from schemas
- Wrap all 6 handlers in `asyncHandler()`
- Replace all `res.status(400).json(...)` with `throw new BadRequestError(...)`
- Replace all `res.status(404).json(...)` with `throw new NotFoundError(...)`
- Replace all `res.status(409).json(...)` with `throw new ConflictError(...)`
- Replace all `res.json({ success: true, ... })` with `sendSuccess(res, ...)`
- Replace all `res.status(201).json(...)` with `sendCreated(res, ...)`
- Remove all try-catch blocks (asyncHandler handles this)
- Add `validate(createAgentSchema)` to POST handler
- Add `validate(updateAgentSchema)` to PATCH handler
- Add `validate(updateAgentStatusSchema)` to PATCH status handler

- [ ] **Step 2: Convert auth.routes.ts**

Same pattern. Import `widgetAuthSchema`. Add `validate(widgetAuthSchema)` to widget auth POST handler.

- [ ] **Step 3: Convert chat.routes.ts**

Same pattern. Import `sendMessageSchema`, `chatListQuerySchema`. Add `validate(chatListQuerySchema, 'query')` to GET list endpoints. Add `validate(sendMessageSchema)` to POST message endpoint.

- [ ] **Step 4: Convert analytics.routes.ts**

Same pattern. Import `analyticsQuerySchema`. Add `validate(analyticsQuerySchema, 'query')` to GET endpoints where applicable.

- [ ] **Step 5: Convert files.routes.ts**

Same pattern. No schemas needed (file uploads use multipart, not JSON body).

- [ ] **Step 6: Convert handsoff.routes.ts**

Same pattern. Import `requestHandoffSchema`. Add `validate(requestHandoffSchema)` to POST handoff request.

- [ ] **Step 6a: Intermediate compile check**

Run: `/opt/homebrew/bin/npm run build --prefix api`
Expected: Clean compilation. Fix any issues before continuing.

- [ ] **Step 7: Convert notifications.routes.ts**

Same pattern. No schemas needed (simple mark-read operations).

- [ ] **Step 8: Convert users.routes.ts**

Same pattern. Import `updateProfileSchema`. Add `validate(updateProfileSchema)` to PATCH profile.

- [ ] **Step 9: Convert webhook-admin.routes.ts**

Same pattern. No body schemas needed (mostly GET endpoints).

- [ ] **Step 10: Convert widget.ts**

Same pattern. Uses `widgetAuthSchema` for auth operations.

- [ ] **Step 11: Convert clerk-webhook.routes.ts**

Same pattern. Minimal changes — webhook receivers have their own validation via Clerk SDK.

- [ ] **Step 11a: Intermediate compile check**

Run: `/opt/homebrew/bin/npm run build --prefix api`
Expected: Clean compilation. Fix any issues before continuing.

- [ ] **Step 12: Convert admin.routes.ts**

Same pattern. Import `createTenantSchema`, `updateUserRoleSchema`, `adminUpdateUserSchema`, `inviteMemberSchema`. This is the largest file (842 lines) — apply systematically to all ~15 handlers.

- [ ] **Step 13: Verify API compiles**

Run: `/opt/homebrew/bin/npm run build --prefix api`
Expected: Clean compilation

- [ ] **Step 14: Commit**

```bash
git add api/src/routes/
git commit -m "refactor(api): convert all routes to asyncHandler + error classes + sendSuccess + Zod validation"
```

---

---

## Workstream B: Portal TanStack Query Refactor

### Task 6: Query Keys Factory

**Files:**
- Create: `portal/src/queries/queryKeys.ts`

- [ ] **Step 1: Create the hierarchical query key factory**

```ts
// portal/src/queries/queryKeys.ts
export const queryKeys = {
  agents: {
    all: () => ['agents'] as const,
    lists: () => [...queryKeys.agents.all(), 'list'] as const,
    list: (filters?: Record<string, unknown>) => [...queryKeys.agents.lists(), filters] as const,
    detail: (id: string) => [...queryKeys.agents.all(), 'detail', id] as const,
    performance: (id: string) => [...queryKeys.agents.detail(id), 'performance'] as const,
    shifts: (id: string) => [...queryKeys.agents.detail(id), 'shifts'] as const,
  },
  tenants: {
    all: () => ['tenants'] as const,
    me: () => [...queryKeys.tenants.all(), 'me'] as const,
    lists: () => [...queryKeys.tenants.all(), 'list'] as const,
    detail: (id: string) => [...queryKeys.tenants.all(), 'detail', id] as const,
    auditLogs: (id: string) => [...queryKeys.tenants.detail(id), 'audit-logs'] as const,
    members: () => [...queryKeys.tenants.me(), 'members'] as const,
    invites: () => [...queryKeys.tenants.me(), 'invites'] as const,
  },
  chats: {
    all: () => ['chats'] as const,
    list: (filters?: Record<string, unknown>) => [...queryKeys.chats.all(), 'list', filters] as const,
    detail: (id: string) => [...queryKeys.chats.all(), 'detail', id] as const,
    messages: (id: string) => [...queryKeys.chats.detail(id), 'messages'] as const,
  },
  handoffs: {
    all: () => ['handoffs'] as const,
    list: (status?: string) => [...queryKeys.handoffs.all(), 'list', status] as const,
  },
  webhooks: {
    all: () => ['webhooks'] as const,
    status: () => [...queryKeys.webhooks.all(), 'status'] as const,
    deliveries: (page?: number) => [...queryKeys.webhooks.all(), 'deliveries', page] as const,
  },
  dashboard: {
    all: () => ['dashboard'] as const,
    metrics: () => [...queryKeys.dashboard.all(), 'metrics'] as const,
  },
  notifications: {
    all: () => ['notifications'] as const,
    list: () => [...queryKeys.notifications.all(), 'list'] as const,
  },
  analytics: {
    all: () => ['analytics'] as const,
    timeseries: (startDate?: string, endDate?: string) => [...queryKeys.analytics.all(), 'timeseries', startDate, endDate] as const,
    chatMetrics: (from?: string, to?: string) => [...queryKeys.analytics.all(), 'chat-metrics', from, to] as const,
    agents: () => [...queryKeys.analytics.all(), 'agents'] as const,
  },
  admin: {
    all: () => ['admin'] as const,
    users: () => [...queryKeys.admin.all(), 'users'] as const,
    analytics: () => [...queryKeys.admin.all(), 'analytics'] as const,
    tenants: () => [...queryKeys.admin.all(), 'tenants'] as const,
    tenantDetail: (id: string) => [...queryKeys.admin.all(), 'tenant-detail', id] as const,
    tenantAudit: (id: string) => [...queryKeys.admin.tenantDetail(id), 'audit'] as const,
    auditLogs: () => [...queryKeys.admin.all(), 'audit-logs'] as const,
  },
};
```

- [ ] **Step 2: Verify portal compiles**

Run: `/opt/homebrew/bin/npm run build --prefix portal`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add portal/src/queries/queryKeys.ts
git commit -m "feat(portal): add hierarchical query key factory"
```

---

### Task 7: QueryClient Configuration

**Files:**
- Create: `portal/src/queries/queryConfig.ts`
- Modify: `portal/src/App.tsx`

- [ ] **Step 1: Create queryConfig.ts**

```ts
// portal/src/queries/queryConfig.ts
import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { toast } from 'sonner';

function extractErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const data = error.response?.data;
    if (data?.error?.message) return data.error.message;
    if (typeof data?.error === 'string') return data.error;
    return error.message;
  }
  return error instanceof Error ? error.message : 'An unexpected error occurred';
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        // Only toast on background refetch failures (not first loads)
        if (query.state.data !== undefined) {
          toast.error(`Update failed: ${extractErrorMessage(error)}`);
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        // Only toast if the mutation didn't define its own onError
        if (!mutation.options.onError) {
          toast.error(extractErrorMessage(error));
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
        retry: 2,
      },
    },
  });
}
```

- [ ] **Step 2: Update App.tsx to use createQueryClient**

In `portal/src/App.tsx`, replace the inline QueryClient creation:

```ts
// Replace:
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// ...
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 2,
    },
  },
});

// With:
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queries/queryConfig';
// ...
const queryClient = createQueryClient();
```

- [ ] **Step 3: Verify portal compiles**

Run: `/opt/homebrew/bin/npm run build --prefix portal`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add portal/src/queries/queryConfig.ts portal/src/App.tsx
git commit -m "feat(portal): add global QueryClient config with error handling"
```

---

### Task 8: Domain Query Hooks — Simple Query-Only Pages

**Files:**
- Create: `portal/src/queries/useDashboardQueries.ts`
- Create: `portal/src/queries/useAnalyticsQueries.ts`
- Create: `portal/src/queries/useAdminQueries.ts`
- Modify: `portal/src/pages/Dashboard.tsx`
- Modify: `portal/src/pages/Analytics.tsx`
- Modify: `portal/src/pages/LiveMonitor.tsx`
- Modify: `portal/src/pages/admin/AdminAnalytics.tsx`
- Modify: `portal/src/components/admin/TenantContextSwitcher.tsx`

Start with the simplest pages (query-only, no mutations) to establish the pattern.

- [ ] **Step 1: Create useDashboardQueries.ts**

```ts
// portal/src/queries/useDashboardQueries.ts
import { useQuery, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

// Types — match the existing DashboardApiResponse from Dashboard.tsx
interface DashboardApiResponse {
  activeSessions: number;
  totalMessages: number;
  avgResponseTime: number;
  avgResolutionTime: number;
  csatScore: number | null;
  activeAgents: number;
  queueSize: number;
  botResolutionRate: number | null;
}

export const dashboardOptions = {
  metrics: () => queryOptions({
    queryKey: queryKeys.dashboard.metrics(),
    queryFn: () => api.get<DashboardApiResponse>('/analytics/dashboard'),
    refetchInterval: 30_000,
  }),
};

export function useDashboardMetrics() {
  return useQuery(dashboardOptions.metrics());
}
```

- [ ] **Step 2: Create useAnalyticsQueries.ts**

```ts
// portal/src/queries/useAnalyticsQueries.ts
import { useQuery, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export const analyticsOptions = {
  timeseries: (startDate: string, endDate: string) => queryOptions({
    queryKey: queryKeys.analytics.timeseries(startDate, endDate),
    queryFn: () => api.get('/analytics/chats/timeseries', { params: { startDate, endDate } }),
  }),
  chatMetrics: (from: string, to: string) => queryOptions({
    queryKey: queryKeys.analytics.chatMetrics(from, to),
    queryFn: () => api.get('/analytics/chats', { params: { from, to } }),
  }),
  agents: () => queryOptions({
    queryKey: queryKeys.analytics.agents(),
    queryFn: () => api.get('/analytics/agents'),
  }),
};

export function useAnalyticsTimeseries(startDate: string, endDate: string, enabled: boolean) {
  return useQuery({ ...analyticsOptions.timeseries(startDate, endDate), enabled });
}

export function useAnalyticsChatMetrics(from: string, to: string, enabled: boolean) {
  return useQuery({ ...analyticsOptions.chatMetrics(from, to), enabled });
}

export function useAnalyticsAgents(enabled: boolean) {
  return useQuery({ ...analyticsOptions.agents(), enabled });
}
```

- [ ] **Step 3: Create useAdminQueries.ts**

```ts
// portal/src/queries/useAdminQueries.ts
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

export const adminOptions = {
  tenants: () => queryOptions({
    queryKey: queryKeys.admin.tenants(),
    queryFn: () => api.get('/admin/tenants'),
  }),
  tenantDetail: (id: string) => queryOptions({
    queryKey: queryKeys.admin.tenantDetail(id),
    queryFn: () => api.get(`/admin/tenants/${id}`),
    enabled: !!id,
  }),
  tenantAudit: (id: string) => queryOptions({
    queryKey: queryKeys.admin.tenantAudit(id),
    queryFn: () => api.get(`/admin/tenants/${id}/audit-logs?limit=20`),
    refetchInterval: 30_000,
    enabled: !!id,
  }),
  users: () => queryOptions({
    queryKey: queryKeys.admin.users(),
    queryFn: () => api.get('/admin/users'),
  }),
  analytics: () => queryOptions({
    queryKey: queryKeys.admin.analytics(),
    queryFn: () => api.get('/admin/analytics'),
  }),
};

export function useAdminTenants() {
  return useQuery(adminOptions.tenants());
}

export function useAdminTenantDetail(id: string) {
  return useQuery(adminOptions.tenantDetail(id));
}

export function useAdminTenantAudit(id: string) {
  return useQuery(adminOptions.tenantAudit(id));
}

export function useAdminUsers() {
  return useQuery(adminOptions.users());
}

export function useAdminAnalytics() {
  return useQuery(adminOptions.analytics());
}

// --- Mutations ---

export function useSuspendTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/tenants/${id}/suspend`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants() });
      toast.success('Tenant suspended');
    },
  });
}

export function useActivateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/tenants/${id}/activate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants() });
      toast.success('Tenant activated');
    },
  });
}

export function useCreateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; slug: string; tier?: string; ownerEmail: string; ownerName: string }) =>
      api.post('/admin/tenants', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants() });
      toast.success('Tenant created');
    },
  });
}

export function usePromoteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/promote`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
      toast.success('User promoted to super admin');
    },
  });
}

export function useDemoteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/demote`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
      toast.success('User demoted');
    },
  });
}
```

- [ ] **Step 4: Migrate Dashboard.tsx**

In `portal/src/pages/Dashboard.tsx`:
- Remove `import { useQuery } from '@tanstack/react-query'`
- Add `import { useDashboardMetrics } from '../queries/useDashboardQueries'`
- Replace inline `useQuery({ queryKey: ['dashboard-metrics'], ... })` with `useDashboardMetrics()`
- Keep the `mapApiToMetrics()` transform — it operates on the query's `data`

- [ ] **Step 5: Migrate Analytics.tsx**

In `portal/src/pages/Analytics.tsx`:
- Remove `import { useQuery } from '@tanstack/react-query'`
- Add imports from `useAnalyticsQueries`
- Replace 3 inline useQuery calls with `useAnalyticsTimeseries(...)`, `useAnalyticsChatMetrics(...)`, `useAnalyticsAgents(...)`

- [ ] **Step 6: Migrate LiveMonitor.tsx**

In `portal/src/pages/LiveMonitor.tsx`:
- Remove `import { useQuery } from '@tanstack/react-query'`
- The tenant query uses key `['tenant', 'me']` — this will be handled by `useTenantQueries` (Task 9). For now, import from tenant queries or use `queryKeys.tenants.me()` directly.

- [ ] **Step 7: Migrate AdminAnalytics.tsx**

Replace inline `useQuery({ queryKey: ['admin', 'analytics'], ... })` with `useAdminAnalytics()`.

- [ ] **Step 8: Migrate TenantContextSwitcher.tsx**

Replace inline `useQuery({ queryKey: ['admin-tenants-switcher'], ... })` with `useAdminTenants()`. Note: this changes the query key from `['admin-tenants-switcher']` to `['admin', 'tenants']` — mutations that previously invalidated `['admin-tenants-switcher']` now invalidate `['admin', 'tenants']` which is already handled in `useAdminQueries`.

- [ ] **Step 9: Verify portal compiles**

Run: `/opt/homebrew/bin/npm run build --prefix portal`
Expected: Clean compilation

- [ ] **Step 10: Commit**

```bash
git add portal/src/queries/ portal/src/pages/ portal/src/components/
git commit -m "feat(portal): migrate query-only pages to domain query hooks"
```

---

### Task 9: Domain Query Hooks — Pages with Mutations

**Files:**
- Create: `portal/src/queries/useAgentQueries.ts`
- Create: `portal/src/queries/useTenantQueries.ts`
- Create: `portal/src/queries/useWebhookQueries.ts`
- Create: `portal/src/queries/useNotificationQueries.ts`
- Modify: `portal/src/pages/Team.tsx`
- Modify: `portal/src/pages/Tenants.tsx`
- Modify: `portal/src/components/settings/IntegrationTab.tsx`
- Modify: `portal/src/pages/admin/AdminTenants.tsx`
- Modify: `portal/src/pages/admin/AdminTenantDetail.tsx`
- Modify: `portal/src/pages/admin/AdminUsers.tsx`
- Modify: `portal/src/pages/ChatTakeover.tsx`

- [ ] **Step 1: Create useAgentQueries.ts**

```ts
// portal/src/queries/useAgentQueries.ts
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export const agentOptions = {
  list: (filters?: Record<string, unknown>) => queryOptions({
    queryKey: queryKeys.agents.list(filters),
    queryFn: () => api.get('/agents', { params: filters }),
  }),
  detail: (id: string) => queryOptions({
    queryKey: queryKeys.agents.detail(id),
    queryFn: () => api.get(`/agents/${id}`),
    enabled: !!id,
  }),
  shifts: (id: string) => queryOptions({
    queryKey: queryKeys.agents.shifts(id),
    queryFn: () => api.get(`/agents/${id}/shifts`),
    enabled: !!id,
  }),
  performance: (id: string) => queryOptions({
    queryKey: queryKeys.agents.performance(id),
    queryFn: () => api.get(`/agents/${id}/performance`),
    enabled: !!id,
  }),
};

export function useAgentList(filters?: Record<string, unknown>) {
  return useQuery(agentOptions.list(filters));
}

export function useAgentDetail(id: string) {
  return useQuery(agentOptions.detail(id));
}

export function useAgentShifts(id: string) {
  return useQuery(agentOptions.shifts(id));
}

export function useAgentPerformance(id: string) {
  return useQuery(agentOptions.performance(id));
}

export function useUpdateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) =>
      api.patch(`/agents/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.all() });
    },
  });
}

export function useUpdateAgentStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/agents/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.all() });
    },
  });
}

export function useCreateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => api.post('/agents', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.all() });
    },
  });
}
```

- [ ] **Step 2: Create useTenantQueries.ts**

```ts
// portal/src/queries/useTenantQueries.ts
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

export const tenantOptions = {
  me: () => queryOptions({
    queryKey: queryKeys.tenants.me(),
    queryFn: () => api.get('/tenants/me'),
  }),
  members: () => queryOptions({
    queryKey: queryKeys.tenants.members(),
    queryFn: () => api.get('/tenants/me/users'),
  }),
  invites: () => queryOptions({
    queryKey: queryKeys.tenants.invites(),
    queryFn: () => api.get('/tenants/me/pending-invites'),
  }),
};

export function useTenantSettings() {
  return useQuery(tenantOptions.me());
}

export function useTenantMembers() {
  return useQuery(tenantOptions.members());
}

export function useTenantInvites() {
  return useQuery(tenantOptions.invites());
}

export function useUpdateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => api.patch('/tenants/me', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      toast.success('Settings saved');
    },
  });
}

export function useRotateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/tenants/me/api-key/rotate'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      toast.success('API key rotated');
    },
  });
}

export function useInviteMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { email: string; name: string; role: string }) =>
      api.post('/tenants/me/invite', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.invites() });
      toast.success('Invitation sent');
    },
  });
}

export function useResendInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => api.post(`/tenants/me/pending-invites/${inviteId}/resend`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.invites() });
      toast.success('Invitation resent');
    },
  });
}

export function useCancelInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => api.delete(`/tenants/me/pending-invites/${inviteId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.invites() });
      toast.success('Invitation cancelled');
    },
  });
}

export function useUpdateMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api.patch(`/tenants/me/users/${userId}`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
      toast.success('Role updated');
    },
  });
}

export function useDeactivateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.post(`/tenants/me/users/${userId}/deactivate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
      toast.success('Member deactivated');
    },
  });
}

export function useReactivateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.post(`/tenants/me/users/${userId}/reactivate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.members() });
      toast.success('Member reactivated');
    },
  });
}
```

- [ ] **Step 3: Create useWebhookQueries.ts**

```ts
// portal/src/queries/useWebhookQueries.ts
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

export const webhookOptions = {
  status: () => queryOptions({
    queryKey: queryKeys.webhooks.status(),
    queryFn: () => api.get('/tenants/me/webhooks/status'),
    refetchInterval: 30_000,
  }),
  deliveries: (page: number) => queryOptions({
    queryKey: queryKeys.webhooks.deliveries(page),
    queryFn: () => api.get(`/tenants/me/webhooks/deliveries?page=${page}&limit=20`),
  }),
};

export function useWebhookStatus() {
  return useQuery(webhookOptions.status());
}

export function useWebhookDeliveries(page: number) {
  return useQuery(webhookOptions.deliveries(page));
}

export function useSaveWebhookUrl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (webhookUrl: string) => api.patch('/tenants/me', { webhookUrl }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.status() });
      toast.success('Webhook URL saved');
    },
  });
}

export function useTestWebhook() {
  return useMutation({
    mutationFn: () => api.post('/tenants/me/webhooks/test'),
    onSuccess: () => {
      toast.success('Test webhook sent');
    },
  });
}
```

- [ ] **Step 4: Create useNotificationQueries.ts**

```ts
// portal/src/queries/useNotificationQueries.ts
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export const notificationOptions = {
  list: () => queryOptions({
    queryKey: queryKeys.notifications.list(),
    queryFn: () => api.get('/notifications'),
  }),
};

export function useNotifications() {
  return useQuery(notificationOptions.list());
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch(`/notifications/${id}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.patch('/notifications/read-all'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() });
    },
  });
}
```

- [ ] **Step 5: Migrate Team.tsx**

Replace all inline `useQuery`/`useMutation` with hooks from `useAgentQueries` and `useTenantQueries`:
- `useQuery({ queryKey: ['agents'], ... })` → `useAgentList()`
- `useQuery({ queryKey: ['agents', id, 'shifts'], ... })` → `useAgentShifts(id)`
- `useQuery({ queryKey: ['agents', 'performance', ...], ... })` — Note: the existing pattern fetches all agents' performance in one query via `Promise.all`. Create a custom `useAgentPerformanceMap(agentIds)` in `useAgentQueries.ts` that preserves this batch pattern.
- `useMutation` for agent update → `useUpdateAgent()`
- `useMutation` for status update → `useUpdateAgentStatus()`
- `useQuery({ queryKey: ['team-members'], ... })` → `useTenantMembers()`
- `useQuery({ queryKey: ['pending-invites'], ... })` → `useTenantInvites()`
- Invite/resend/cancel mutations → `useInviteMember()`, `useResendInvite()`, `useCancelInvite()`
- Member role/deactivate/reactivate → `useUpdateMemberRole()`, `useDeactivateMember()`, `useReactivateMember()`
- Remove `useQueryClient` import (handled inside hooks)
- Keep `mapApiAgent()` transform on query data

- [ ] **Step 6: Migrate Tenants.tsx**

- `useQuery({ queryKey: ['tenant', 'me'], ... })` → `useTenantSettings()`
- `useMutation` for update → `useUpdateTenant()`
- `useMutation` for rotate → `useRotateApiKey()`
- Keep `mapApiToTenant()` transform

- [ ] **Step 7: Migrate IntegrationTab.tsx**

- `useQuery({ queryKey: ['tenant-me'], ... })` → `useTenantSettings()`
- `useQuery({ queryKey: ['webhook-status'], ... })` → `useWebhookStatus()`
- `useQuery({ queryKey: ['webhook-deliveries', page], ... })` → `useWebhookDeliveries(page)`
- Replace inline mutations with `useSaveWebhookUrl()`, `useTestWebhook()`

- [ ] **Step 8: Migrate AdminTenants.tsx**

Replace with `useAdminTenants()`, `useSuspendTenant()`, `useActivateTenant()`, `useCreateTenant()` from `useAdminQueries`.

- [ ] **Step 9: Migrate AdminTenantDetail.tsx**

Replace with `useAdminTenantDetail(id)`, `useAdminTenantAudit(id)`, `useSuspendTenant()`, `useActivateTenant()` from `useAdminQueries`.

- [ ] **Step 10: Migrate AdminUsers.tsx**

Replace with `useAdminUsers()`, `usePromoteUser()`, `useDemoteUser()` from `useAdminQueries`.

- [ ] **Step 10a: Migrate AdminAuditLogs.tsx**

This page uses inline `useQuery` with keys `['admin', 'tenants-list']` and `['admin', 'audit-logs', ...]`. Replace with `useAdminTenants()` for the tenant list dropdown and add a `useAdminAuditLogs()` hook to `useAdminQueries.ts`:

```ts
export function useAdminAuditLogs(params?: Record<string, unknown>) {
  return useQuery({
    queryKey: [...queryKeys.admin.auditLogs(), params],
    queryFn: () => api.get('/admin/audit-logs', { params }),
  });
}
```

- [ ] **Step 11: Migrate ChatTakeover.tsx**

Replace `useQuery({ queryKey: ['agents', 'online'], ... })` with `useAgentList({ status: 'online' })` and add `enabled: isTransferModalOpen` option.

- [ ] **Step 12: Verify portal compiles**

Run: `/opt/homebrew/bin/npm run build --prefix portal`
Expected: Clean compilation

- [ ] **Step 13: Commit**

```bash
git add portal/src/queries/ portal/src/pages/ portal/src/components/
git commit -m "feat(portal): migrate all mutation pages to domain query hooks"
```

---

### Task 10: Hybrid Socket.IO + React Query — useChats

**Files:**
- Create: `portal/src/queries/useChatQueries.ts`
- Modify: `portal/src/hooks/useChats.ts` (will be deleted after migration)
- Modify: `portal/src/hooks/index.ts`

- [ ] **Step 1: Read the existing useChats.ts fully**

Read `portal/src/hooks/useChats.ts` completely to understand all socket event handlers, filtering logic, notification sounds, and state shape. The new implementation must preserve all this behavior.

- [ ] **Step 2: Create useChatQueries.ts with useChatsQuery**

```ts
// portal/src/queries/useChatQueries.ts
import { useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
// Import socket helpers from existing socket service (check portal/src/services/ for exact paths)
// Import types from existing type definitions

export const chatOptions = {
  list: (filters?: Record<string, unknown>) => queryOptions({
    queryKey: queryKeys.chats.list(filters),
    queryFn: () => api.get('/chats/sessions', { params: filters }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  }),
  detail: (id: string) => queryOptions({
    queryKey: queryKeys.chats.detail(id),
    queryFn: () => api.get(`/chats/${id}`),
    enabled: !!id,
  }),
};

// --- Mutations ---

export function useTakeoverChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) => api.post(`/chats/${chatId}/takeover`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.all() });
    },
  });
}

export function useCloseChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) => api.post(`/chats/${chatId}/close`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.all() });
    },
  });
}

// --- Hybrid Socket.IO + React Query ---

export function useChatsQuery(filters?: Record<string, unknown>) {
  const queryClient = useQueryClient();
  const query = useQuery(chatOptions.list(filters));

  useEffect(() => {
    // Subscribe to socket events for real-time updates
    // Preserve: filtering against current filters, notification sounds, sort order
    // Use queryClient.setQueryData(queryKeys.chats.list(filters), updater)
    // for new chats and chat updates

    // Return cleanup function to unsubscribe
  }, [filters, queryClient]);

  return query;
}
```

**Implementation note:** Tasks 10-12 contain skeleton code for the socket integration. The implementer MUST read the existing hook files (`useChats.ts`, `useHandoffs.ts`, `useChat.ts`) fully before writing the implementations, as the socket service imports, event names, and exact handler logic vary. The skeletons show the React Query structure; the socket event handler bodies must be ported from the existing hooks.

The implementer must read the existing `useChats.ts` socket handlers and reproduce:
- `onChatNew`: filter against current filters, prepend to list, play notification sound
- `onChatUpdate`: update existing chat in list, re-sort by last activity
- Both use `queryClient.setQueryData` to update the cache

- [ ] **Step 3: Delete useChats.ts and update hooks/index.ts**

Remove `portal/src/hooks/useChats.ts`. Update `portal/src/hooks/index.ts` to remove the `useChats` re-export.

- [ ] **Step 4: Update all consumers of useChats**

Search for `useChats` imports across the portal and update to import from `../queries/useChatQueries` instead. Main consumers: `Dashboard.tsx`, `ChatTakeover.tsx`, and any sidebar/layout components.

- [ ] **Step 5: Verify portal compiles**

Run: `/opt/homebrew/bin/npm run build --prefix portal`
Expected: Clean compilation

- [ ] **Step 6: Commit**

```bash
git add portal/src/queries/useChatQueries.ts portal/src/hooks/ portal/src/pages/ portal/src/components/
git commit -m "feat(portal): migrate useChats to hybrid Socket.IO + React Query"
```

---

### Task 11: Hybrid Socket.IO + React Query — useHandoffs

**Files:**
- Create or modify: `portal/src/queries/useHandoffQueries.ts`
- Modify: `portal/src/hooks/useHandoffs.ts` (will be deleted)
- Modify: `portal/src/hooks/index.ts`

- [ ] **Step 1: Read the existing useHandoffs.ts fully**

Read `portal/src/hooks/useHandoffs.ts` to understand socket event handlers, status filtering, and notification sounds.

- [ ] **Step 2: Create useHandoffQueries.ts**

```ts
// portal/src/queries/useHandoffQueries.ts
import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export const handoffOptions = {
  list: (status?: string) => queryOptions({
    queryKey: queryKeys.handoffs.list(status),
    queryFn: () => api.get('/handoffs/pending'),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  }),
};

export function useHandoffsQuery(status?: string) {
  const queryClient = useQueryClient();
  const query = useQuery(handoffOptions.list(status));

  useEffect(() => {
    // Subscribe to socket events for real-time handoff updates
    // Preserve: status filtering, notification sounds
    // Use queryClient.setQueryData for instant updates

    // Return cleanup function
  }, [status, queryClient]);

  return query;
}

export function useAcceptHandoff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/handoffs/${id}/accept`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.handoffs.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.all() });
    },
  });
}

export function useRejectHandoff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/handoffs/${id}/reject`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.handoffs.all() });
    },
  });
}
```

- [ ] **Step 3: Delete useHandoffs.ts and update hooks/index.ts**

Remove `portal/src/hooks/useHandoffs.ts`. Update `portal/src/hooks/index.ts`.

- [ ] **Step 4: Update all consumers**

Update imports across Dashboard.tsx, ChatTakeover.tsx, and any other consumers.

- [ ] **Step 5: Verify portal compiles**

Run: `/opt/homebrew/bin/npm run build --prefix portal`
Expected: Clean compilation

- [ ] **Step 6: Commit**

```bash
git add portal/src/queries/useHandoffQueries.ts portal/src/hooks/ portal/src/pages/
git commit -m "feat(portal): migrate useHandoffs to hybrid Socket.IO + React Query"
```

---

### Task 12: Hybrid Socket.IO + React Query — useChat (Single Chat)

**Files:**
- Modify: `portal/src/queries/useChatQueries.ts` (add single-chat hook)
- Modify: `portal/src/hooks/useChat.ts` (will be deleted)
- Modify: `portal/src/hooks/index.ts`

This is the most complex hook. It manages room join/leave, typing indicators, message deduplication, and outbound message sending via socket. Typing indicators and room management remain as local state alongside the query cache.

- [ ] **Step 1: Read the existing useChat.ts fully**

Read `portal/src/hooks/useChat.ts` completely. Note:
- Room join/leave lifecycle (`joinChat`/`leaveChat`)
- Typing indicator refs (`typingTimeoutRef`, `setTypingUsers`)
- Message deduplication logic
- `sendMessage` function (socket-based, not HTTP)
- Socket event handlers: `onMessageReceived`, `onTypingUpdate`, `onChatUpdate`

- [ ] **Step 2: Add useChatDetail to useChatQueries.ts**

Add to `portal/src/queries/useChatQueries.ts`:

```ts
import { useState, useEffect, useRef, useCallback } from 'react';

export function useChatDetail(chatId: string) {
  const queryClient = useQueryClient();

  // Query for initial chat data + messages
  const chatQuery = useQuery(chatOptions.detail(chatId));
  const messagesQuery = useQuery(chatOptions.messages(chatId));

  // --- Local state for imperative concerns (NOT in React Query) ---
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const typingTimeoutRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  useEffect(() => {
    if (!chatId) return;

    // Join socket room
    // socketJoinChat(chatId);

    // Socket event handlers:
    // onMessageReceived: deduplicate, then queryClient.setQueryData to append message
    // onTypingUpdate: update typingUsers local state, manage timeout refs
    // onChatUpdate: queryClient.setQueryData to update chat detail

    return () => {
      // Leave socket room
      // socketLeaveChat(chatId);
      // Clear typing timeouts
      typingTimeoutRef.current.forEach(clearTimeout);
      typingTimeoutRef.current.clear();
    };
  }, [chatId, queryClient]);

  // Send message via socket (imperative, not a mutation)
  const sendMessage = useCallback((content: string, type?: string) => {
    if (!chatId || !content.trim()) return;
    // socketSendMessage(chatId, { content, type });
  }, [chatId]);

  return {
    chat: chatQuery.data,
    messages: messagesQuery.data,
    isLoading: chatQuery.isLoading || messagesQuery.isLoading,
    typingUsers,
    sendMessage,
  };
}
```

The implementer must read the existing `useChat.ts` and reproduce all socket event handlers, room management, and typing indicator logic exactly.

- [ ] **Step 3: Delete useChat.ts and update hooks/index.ts**

Remove `portal/src/hooks/useChat.ts`. Update `portal/src/hooks/index.ts`.

- [ ] **Step 4: Update all consumers**

Update `ChatTakeover.tsx` and any other consumers to import from `useChatQueries`.

- [ ] **Step 5: Verify portal compiles**

Run: `/opt/homebrew/bin/npm run build --prefix portal`
Expected: Clean compilation

- [ ] **Step 6: Commit**

```bash
git add portal/src/queries/useChatQueries.ts portal/src/hooks/ portal/src/pages/
git commit -m "feat(portal): migrate useChat to hybrid Socket.IO + React Query with typing indicators"
```

---

### Task 13: Optimistic Updates for Toggle Mutations

**Files:**
- Modify: `portal/src/queries/useAgentQueries.ts`
- Modify: `portal/src/queries/useNotificationQueries.ts`

Add optimistic updates to simple toggle/status mutations per the spec. Use Pattern A (UI-based) for simplest cases, Pattern B (cache-based) where the display component differs from the trigger.

- [ ] **Step 1: Add optimistic toggle to useUpdateAgentStatus**

In `portal/src/queries/useAgentQueries.ts`, update `useUpdateAgentStatus` to use UI-based optimistic pattern. The mutation already returns `{ variables, isPending }` — consumers can render optimistic state:

```ts
// In the component:
// const statusMutation = useUpdateAgentStatus();
// Display: statusMutation.isPending ? statusMutation.variables.status : agent.status
```

No code changes needed in the hook — the UI-based pattern uses the mutation's built-in `variables` and `isPending`. Document this pattern in a comment in the hook file.

- [ ] **Step 2: Add optimistic cache update to useMarkAllNotificationsRead**

In `portal/src/queries/useNotificationQueries.ts`, add cache-based optimistic update since the notification bell/count may be in a different component than the trigger:

```ts
export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.patch('/notifications/read-all'),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.notifications.all() });
      const previous = queryClient.getQueryData(queryKeys.notifications.list());
      queryClient.setQueryData(queryKeys.notifications.list(), (old: unknown[]) =>
        old?.map((n: Record<string, unknown>) => ({ ...n, read: true }))
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.notifications.list(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() });
    },
  });
}
```

- [ ] **Step 3: Verify portal compiles**

Run: `/opt/homebrew/bin/npm run build --prefix portal`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add portal/src/queries/useAgentQueries.ts portal/src/queries/useNotificationQueries.ts
git commit -m "feat(portal): add optimistic updates for toggle mutations"
```

---

### Task 14: Barrel Exports + Final Cleanup (was Task 13)

**Files:**
- Create: `portal/src/queries/index.ts`
- Modify: `portal/src/hooks/index.ts`

- [ ] **Step 1: Create queries barrel export**

```ts
// portal/src/queries/index.ts
export { queryKeys } from './queryKeys';
export { createQueryClient } from './queryConfig';

export * from './useAgentQueries';
export * from './useTenantQueries';
export * from './useChatQueries';
export * from './useHandoffQueries';
export * from './useDashboardQueries';
export * from './useWebhookQueries';
export * from './useNotificationQueries';
export * from './useAdminQueries';
export * from './useAnalyticsQueries';
```

- [ ] **Step 2: Clean up hooks/index.ts**

Update `portal/src/hooks/index.ts` to only export the remaining hooks (the ones NOT migrated to queries):

```ts
// portal/src/hooks/index.ts
export { useDebounce } from './useDebounce';
export { useFilePreview } from './useFilePreview';
export { useTyping } from './useTyping';
```

- [ ] **Step 3: Search for any remaining inline query keys**

Search the entire portal for any remaining hardcoded query key strings that were missed:

Run: `grep -r "queryKey: \['" portal/src/pages/ portal/src/components/ --include="*.tsx" --include="*.ts"`

Fix any remaining inline keys to use the `queryKeys` factory.

- [ ] **Step 4: Verify both projects compile**

Run: `/opt/homebrew/bin/npm run build --prefix api`
Run: `/opt/homebrew/bin/npm run build --prefix portal`
Expected: Both pass clean

- [ ] **Step 5: Commit**

```bash
git add portal/src/queries/index.ts portal/src/hooks/index.ts
git commit -m "feat(portal): add barrel exports and clean up hook index"
```

---

## Verification Checklist

After all tasks are complete:

- [ ] API compiles cleanly (`npm run build --prefix api`)
- [ ] Portal compiles cleanly (`npm run build --prefix portal`)
- [ ] No remaining inline `res.status(XXX).json({ error: ... })` in route files (except tenants.ts which was already compliant)
- [ ] No remaining hardcoded query key strings in portal pages/components (including AdminAuditLogs.tsx)
- [ ] All mutations have proper cache invalidation via `queryKeys.*`
- [ ] Socket hooks preserve filtering, notification sounds, and typing indicators
- [ ] Response envelope unwrapping works in apiClient interceptor
