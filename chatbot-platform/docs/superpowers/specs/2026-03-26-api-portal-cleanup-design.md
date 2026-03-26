# API Consistency & TanStack Query Best Practices

**Date:** 2026-03-26
**Status:** Approved
**Scope:** API server consistency pass + Portal React Query refactor

---

## Overview

Two-pronged cleanup: (1) standardize API server patterns for error handling, validation, and response format, and (2) refactor all Portal data fetching to follow TanStack Query best practices with a centralized query layer.

---

## Part 1: API Consistency Pass

### 1.1 Request ID Middleware

New middleware `api/src/middleware/request-id.middleware.ts` registered early in the stack (before all other middleware in `server.ts`).

- Generates a UUID per request via `crypto.randomUUID()`
- Respects incoming `x-request-id` header if present (for distributed tracing)
- Sets `req.requestId` and returns it via `x-request-id` response header
- The existing error handler in `error-handler.ts` already logs `requestId` — this provides the value it expects

### 1.2 Response Wrapper

New utility `api/src/utils/response.ts` with two helpers:

- `sendSuccess(res, data, meta?)` — wraps response in `{ success: true, data, meta? }`
- `sendPaginated(res, data, pagination)` — wraps response in `{ success: true, data, meta: { pagination } }`

All route handlers must use these instead of raw `res.json()`. This enforces a consistent envelope across all endpoints.

### 1.3 Enforce asyncHandler + Error Classes

All route handlers wrapped in the existing `asyncHandler` from `error-handler.ts`. All validation/error responses converted from manual `res.status().json()` to throwing typed error classes:

- `BadRequestError` — missing/invalid input
- `NotFoundError` — resource not found
- `ForbiddenError` — insufficient permissions
- `ConflictError` — duplicate resource
- `ValidationError` — Zod validation failures

The centralized error handler already handles all of these — this change ensures every route uses it consistently.

**Files requiring conversion** (currently use manual responses):
- `chat.routes.ts`
- `agents.routes.ts`
- `auth.routes.ts`
- `files.routes.ts`
- `handsoff.routes.ts`
- `notifications.routes.ts`
- `widget.ts`

Files already compliant: `tenants.ts`, `admin.routes.ts` (partially).

### 1.4 Zod Validation Schemas

New directory `api/src/schemas/` with schema files per domain:

- `agent.schema.ts` — createAgent, updateAgent
- `tenant.schema.ts` — updateTenant, inviteMember
- `chat.schema.ts` — sendMessage
- `auth.schema.ts` — widgetAuth
- `handoff.schema.ts` — requestHandoff
- `webhook.schema.ts` — webhook config
- `admin.schema.ts` — admin-specific operations
- `user.schema.ts` — updateProfile, changePassword

New validation middleware `api/src/middleware/validate.ts`:

```ts
export function validate(schema: ZodSchema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) throw new ValidationError('Validation failed', result.error.flatten());
    req.body = result.data;
    next();
  };
}
```

Used as route-level middleware: `router.post('/agents', validate(createAgentSchema), asyncHandler(handler))`.

---

## Part 2: TanStack Query Refactor

### 2.1 Query Key Factory

New file `portal/src/queries/queryKeys.ts` with hierarchical keys for all domains:

```ts
export const queryKeys = {
  agents: {
    all: () => ['agents'] as const,
    lists: () => [...queryKeys.agents.all(), 'list'] as const,
    list: (filters?) => [...queryKeys.agents.lists(), filters] as const,
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
    list: (filters?) => [...queryKeys.chats.all(), 'list', filters] as const,
    detail: (id: string) => [...queryKeys.chats.all(), 'detail', id] as const,
    messages: (id: string) => [...queryKeys.chats.detail(id), 'messages'] as const,
  },
  handoffs: {
    all: () => ['handoffs'] as const,
    list: (status?) => [...queryKeys.handoffs.all(), 'list', status] as const,
  },
  webhooks: {
    all: () => ['webhooks'] as const,
    status: () => [...queryKeys.webhooks.all(), 'status'] as const,
    deliveries: (page?) => [...queryKeys.webhooks.all(), 'deliveries', page] as const,
  },
  dashboard: {
    all: () => ['dashboard'] as const,
    metrics: () => [...queryKeys.dashboard.all(), 'metrics'] as const,
  },
  notifications: {
    all: () => ['notifications'] as const,
    list: () => [...queryKeys.notifications.all(), 'list'] as const,
  },
  admin: {
    all: () => ['admin'] as const,
    users: () => [...queryKeys.admin.all(), 'users'] as const,
    analytics: () => [...queryKeys.admin.all(), 'analytics'] as const,
    tenants: () => [...queryKeys.admin.all(), 'tenants'] as const,
    tenantDetail: (id: string) => [...queryKeys.admin.all(), 'tenant-detail', id] as const,
    auditLogs: () => [...queryKeys.admin.all(), 'audit-logs'] as const,
  },
}
```

Invalidation hierarchy:
- `queryKeys.agents.all()` invalidates all agent queries
- `queryKeys.agents.detail('abc')` invalidates one agent + its sub-queries (performance, shifts)
- `queryKeys.tenants.me()` invalidates tenant settings + members + invites

### 2.2 Global QueryClient Configuration

New file `portal/src/queries/queryConfig.ts`:

- `QueryCache.onError` — toasts only on background refetch failures (not first loads)
- `MutationCache.onError` — global fallback, skips if mutation has its own `onError`
- `extractErrorMessage()` — pulls actual API error from Axios response instead of generic text
- Default options: `staleTime: 5min`, `gcTime: 10min`, `retry: 2` for queries, `retry: 0` for mutations
- `refetchOnWindowFocus: true` (explicit)
- Exported as `createQueryClient()` factory function, called in `App.tsx`

### 2.3 Domain Hook Files

New directory structure under `portal/src/queries/`:

```
portal/src/queries/
├── queryKeys.ts
├── queryConfig.ts
├── useAgentQueries.ts
├── useTenantQueries.ts
├── useChatQueries.ts
├── useHandoffQueries.ts
├── useDashboardQueries.ts
├── useWebhookQueries.ts
├── useNotificationQueries.ts
├── useAdminQueries.ts
└── index.ts
```

Each file exports named hooks:
- **Query hooks**: `useAgentList()`, `useAgentDetail(id)`, `useTenantSettings()`, etc.
- **Mutation hooks**: `useCreateAgent()`, `useUpdateTenant()`, `useToggleAgentStatus()`, etc.

Pages become thin consumers:
```ts
const { data: agents, isLoading } = useAgentList();
const toggleStatus = useToggleAgentStatus();
```

### 2.4 Hybrid Socket.IO + React Query Hooks

For `useChats`, `useHandoffs`, and `useChat`:

- `useQuery` handles initial data fetch, caching, loading/error states, and background refetch
- Socket.IO event handlers update the query cache via `queryClient.setQueryData` for instant real-time updates
- `refetchInterval: 30_000` as safety net for missed socket events
- No more manual `useState` + `useEffect` fetch loops

Pattern:
1. `useQuery` fetches initial data from REST API
2. `useEffect` subscribes to Socket.IO events
3. Socket events call `queryClient.setQueryData()` to update cache instantly
4. `onSettled` / `refetchInterval` ensures eventual consistency

### 2.5 Optimistic Updates

Applied to toggle/status mutations only:

- Agent enable/disable
- Member activate/deactivate
- Webhook toggle
- Notification mark-as-read / mark-all-read

Pattern:
1. `onMutate` — cancel in-flight queries, snapshot previous data, optimistically update cache
2. `onError` — rollback to snapshot
3. `onSettled` — invalidate queries to refetch server truth

NOT applied to creates, deletes, or complex updates — those wait for server confirmation.

### 2.6 Migration of Existing Pages

All pages with inline `useQuery`/`useMutation` calls migrated to use domain hooks:

- `Dashboard.tsx` — `useDashboardMetrics()`
- `ChatTakeover.tsx` — `useChatQueries` hooks
- `Team.tsx` — `useTenantMembers()`, `useTenantInvites()`, mutations
- `Tenants.tsx` — `useTenantSettings()`, mutations
- `IntegrationTab.tsx` — `useWebhookStatus()`, `useWebhookDeliveries()`, mutations
- `AdminTenants.tsx` — `useAdminTenants()`, mutations
- `AdminTenantDetail.tsx` — `useAdminTenantDetail(id)`, mutations
- `AdminUsers.tsx` — `useAdminUsers()`, mutations
- `AdminAnalytics.tsx` — `useAdminAnalytics()`
- `TenantContextSwitcher.tsx` — `useAdminTenants()`

All inline query key strings replaced with `queryKeys.*` factory calls.
All inline `onError: () => toast.error('...')` removed (handled by global MutationCache).

---

## Files Changed Summary

### API (new files)
- `api/src/middleware/request-id.middleware.ts`
- `api/src/middleware/validate.ts`
- `api/src/utils/response.ts`
- `api/src/schemas/agent.schema.ts`
- `api/src/schemas/tenant.schema.ts`
- `api/src/schemas/chat.schema.ts`
- `api/src/schemas/auth.schema.ts`
- `api/src/schemas/handoff.schema.ts`
- `api/src/schemas/webhook.schema.ts`
- `api/src/schemas/admin.schema.ts`
- `api/src/schemas/user.schema.ts`

### API (modified files)
- `api/src/server.ts` — register request-id middleware
- `api/src/routes/*.ts` — all route files converted to asyncHandler + error classes + sendSuccess + validate middleware

### Portal (new files)
- `portal/src/queries/queryKeys.ts`
- `portal/src/queries/queryConfig.ts`
- `portal/src/queries/useAgentQueries.ts`
- `portal/src/queries/useTenantQueries.ts`
- `portal/src/queries/useChatQueries.ts`
- `portal/src/queries/useHandoffQueries.ts`
- `portal/src/queries/useDashboardQueries.ts`
- `portal/src/queries/useWebhookQueries.ts`
- `portal/src/queries/useNotificationQueries.ts`
- `portal/src/queries/useAdminQueries.ts`
- `portal/src/queries/index.ts`

### Portal (modified files)
- `portal/src/App.tsx` — use `createQueryClient()` from queryConfig
- `portal/src/hooks/useChats.ts` — removed (logic moves to `queries/useChatQueries.ts`)
- `portal/src/hooks/useHandoffs.ts` — removed (logic moves to `queries/useHandoffQueries.ts`)
- `portal/src/hooks/useChat.ts` — removed (logic moves to `queries/useChatQueries.ts`)
- `portal/src/hooks/index.ts` — updated to remove re-exports of moved hooks
- `portal/src/pages/Dashboard.tsx` — use domain hooks
- `portal/src/pages/ChatTakeover.tsx` — use domain hooks
- `portal/src/pages/Team.tsx` — use domain hooks
- `portal/src/pages/Tenants.tsx` — use domain hooks
- `portal/src/pages/admin/AdminTenants.tsx` — use domain hooks
- `portal/src/pages/admin/AdminTenantDetail.tsx` — use domain hooks
- `portal/src/pages/admin/AdminUsers.tsx` — use domain hooks
- `portal/src/pages/admin/AdminAnalytics.tsx` — use domain hooks
- `portal/src/components/settings/IntegrationTab.tsx` — use domain hooks
- `portal/src/components/admin/TenantContextSwitcher.tsx` — use domain hooks

### Portal (removed after migration)
- Inline `useQuery`/`useMutation` calls removed from all page components
- Manual `useState` + `useEffect` polling removed from `useChats`, `useHandoffs`, `useChat`

---

## Out of Scope

- Service layer extraction (routes keep inline handlers)
- Repository pattern
- Splitting large route files (admin.routes.ts, tenants.ts)
- DI container
- useInfiniteQuery for pagination
- React error boundaries
- Query prefetching
- React Query DevTools
