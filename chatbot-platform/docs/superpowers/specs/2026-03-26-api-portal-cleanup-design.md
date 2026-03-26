# API Consistency & TanStack Query Best Practices

**Date:** 2026-03-26
**Status:** Completed
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

**Migration strategy:** To avoid a big-bang breakage, the portal's `apiClient` interceptor must be updated FIRST to unwrap the new envelope (`response.data.data` → `response.data`). Since the existing error handler already returns `{ success: false, error: {...} }`, the interceptor can check `response.data.success` and unwrap accordingly. This makes the change backward-compatible during the transition — routes can be converted incrementally.

### 1.3 Enforce asyncHandler + Error Classes

All route handlers wrapped in the existing `asyncHandler` from `error-handler.ts`. All validation/error responses converted from manual `res.status().json()` to throwing typed error classes:

- `BadRequestError` — missing/invalid input
- `NotFoundError` — resource not found
- `ForbiddenError` — insufficient permissions
- `ConflictError` — duplicate resource
- `ValidationError` — Zod validation failures

The centralized error handler already handles all of these — this change ensures every route uses it consistently.

**Files requiring conversion** (currently use manual responses):
- `admin.routes.ts`
- `agents.routes.ts`
- `analytics.routes.ts`
- `auth.routes.ts`
- `chat.routes.ts`
- `clerk-webhook.routes.ts`
- `files.routes.ts`
- `handsoff.routes.ts`
- `notifications.routes.ts`
- `users.routes.ts`
- `webhook-admin.routes.ts`
- `widget.ts`

Files already compliant: `tenants.ts` (uses `asyncHandler` + error classes).

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
type Source = 'body' | 'query' | 'params';

export function validate(schema: ZodSchema, source: Source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) throw new ValidationError('Validation failed', result.error.flatten());
    req[source] = result.data;
    next();
  };
}
```

Used as route-level middleware:
- Body: `router.post('/agents', validate(createAgentSchema), asyncHandler(handler))`
- Query params: `router.get('/chats', validate(chatListQuerySchema, 'query'), asyncHandler(handler))`
- Route params: `router.get('/agents/:id', validate(agentParamsSchema, 'params'), asyncHandler(handler))`

New schema file added: `api/src/schemas/analytics.schema.ts` — analytics query filters.

---

## Part 2: TanStack Query Refactor

### 2.1 Query Options Factory

New file `portal/src/queries/queryKeys.ts` with hierarchical keys AND co-located `queryOptions` for all domains. Following TanStack Query v5's recommended `queryOptions()` pattern (per TkDodo), which co-locates `queryKey` and `queryFn` with full type inference:

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

**Convention:** When filters are optional, callers must pass `undefined` (not `{}`) for "no filters" to avoid cache misses from structural inequality.

Domain hook files will use `queryOptions()` to co-locate key + fetch function:

```ts
import { queryOptions } from '@tanstack/react-query';

export const agentOptions = {
  list: (filters?) => queryOptions({
    queryKey: queryKeys.agents.list(filters),
    queryFn: () => api.get('/agents', { params: filters }).then(r => r.data),
  }),
  detail: (id: string) => queryOptions({
    queryKey: queryKeys.agents.detail(id),
    queryFn: () => api.get(`/agents/${id}`).then(r => r.data),
  }),
};

// Usage in components:
const { data } = useQuery(agentOptions.list());
```

This gives full type inference on `data` without manual generics.

### 2.2 Global QueryClient Configuration

New file `portal/src/queries/queryConfig.ts`:

- `QueryCache.onError` — toasts only on background refetch failures (not first loads)
- `MutationCache.onError` — global fallback, skips if mutation has its own `onError`
- `extractErrorMessage()` — pulls actual API error from Axios response instead of generic text
- Default options: `staleTime: 5min`, `gcTime: 10min`, `retry: 2` for queries
- Note: `mutations.retry` defaults to `0` in v5 — no need to set explicitly
- Note: `refetchOnWindowFocus` defaults to `true` in v5 — no need to set explicitly
- Exported as `createQueryClient()` factory function, called in `App.tsx`
- `QueryCache.onError` distinguishes first-load vs background refetch by checking `query.state.data !== undefined` — only toasts when previous data existed (background failure)

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
- `refetchIntervalInBackground: false` — stops polling when tab is hidden to avoid unnecessary network traffic
- No more manual `useState` + `useEffect` fetch loops

Pattern:
1. `useQuery` fetches initial data from REST API
2. `useEffect` subscribes to Socket.IO events
3. Socket events call `queryClient.setQueryData()` to update cache instantly
4. `refetchInterval` ensures eventual consistency

**Complexity to preserve during migration:**

The existing hooks do more than simple data fetching. The migrated hooks must retain this logic:

- **`useChats`**: Socket event filtering against current filters, notification sounds on new chats, sort order maintenance, pagination total updates. These become part of the `setQueryData` updater function and side effects in the socket event handler.
- **`useHandoffs`**: Status-based filtering and notification sounds. Same approach — filter logic in the `setQueryData` updater, sounds as a side effect.
- **`useChat`**: Socket room join/leave (`joinChat`/`leaveChat`), typing indicator state via refs (`typingTimeoutRef`, `setTypingUsers`), message deduplication, and outbound message sending via socket. Typing indicators and room management remain as local state (`useState`/`useRef`) alongside the query cache — they are inherently imperative and do not belong in React Query. The hook returns both query data and imperative controls.

For broader invalidation events (e.g., "something changed elsewhere"), use `queryClient.invalidateQueries()` instead of `setQueryData` — it's lighter-weight and avoids manually constructing cache entries for data the user isn't viewing.

### 2.5 Optimistic Updates

Applied to toggle/status mutations only:

- Agent enable/disable
- Member activate/deactivate
- Webhook toggle
- Notification mark-as-read / mark-all-read

Two patterns available (choose per-mutation based on complexity):

**Pattern A: UI-based (preferred for simple toggles — new in v5)**
Use `variables` and `isPending` from `useMutation` to render optimistic state directly, without touching the cache. On settle, invalidate to refetch. Simpler, fewer edge cases.

```ts
const toggle = useMutation({ mutationFn: ... });
// In render: show toggle.variables.isActive while toggle.isPending
```

**Pattern B: Cache-based (for mutations where the display component differs from the triggering component)**
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
- `Analytics.tsx` — `useAnalyticsQueries` hooks
- `LiveMonitor.tsx` — `useLiveMonitorQueries` hooks

All inline query key strings replaced with `queryOptions` factory calls.
Generic `onError: () => toast.error('...')` removed from mutations (handled by global MutationCache). Mutations that need a specific error message different from the API response may retain a custom `onError` — the global handler skips those.

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
- `api/src/schemas/analytics.schema.ts`
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
- `portal/src/pages/Analytics.tsx` — use domain hooks
- `portal/src/pages/LiveMonitor.tsx` — use domain hooks
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
