# Issue Roadmap Design

**Date:** 2026-03-25
**Scope:** High-level design for issues #7, #19, #20, #21, #22, #23
**Strategy:** Two parallel tracks — data layer improvements and infrastructure

---

## Track 1: Data Layer Improvements

### #23 — Participant Soft-Delete

**Priority:** 1 (Track 1)
**Effort:** Small — single migration + entity update + endpoint

**Schema change:**
Add two columns to the Participant entity, matching the existing Message soft-delete pattern:
- `isDeleted: boolean` — default `false`
- `deletedAt: Date | null` — default `null`

**Behavior:**
- Add `softDelete()` method to Participant entity: sets `isDeleted = true`, `deletedAt = new Date()`, and anonymizes the JSONB `metadata` column (clears browser, OS, device, location fields) for GDPR compliance.
- Update `isActive()` to return `!this.leftAt && !this.isDeleted`.
- All existing queries that fetch participants must filter `WHERE is_deleted = false` — either via explicit conditions in each query or a TypeORM query subscriber.
- Expose `DELETE /api/v1/chats/:sessionId/participants/:id` endpoint that calls `softDelete()` instead of hard-deleting.
- Future work: scheduled job to hard-delete participants where `deletedAt < now - retention_period`.

**Migration:**
Single TypeORM migration adding two columns with defaults. Zero downtime — existing rows get `isDeleted = false` and `deletedAt = null`.

**Files affected:**
- `api/src/database/entities/Participant.ts` — add columns, `softDelete()`, update `isActive()`
- `api/src/routes/chat.routes.ts` — add DELETE endpoint
- Any route/service querying participants — add `isDeleted = false` filter
- New migration file

---

### #20 — Pagination on Lists

**Priority:** 2 (Track 1)
**Effort:** Medium — backend standardization + frontend component + hook updates

**Current state:**
Backend has partial pagination in some routes (chat history uses `offset`/`limit`, agents and handoffs have it). Other list endpoints and the frontend `useChats` hook don't use it consistently.

**Backend — shared pagination pattern:**

Create shared types and a helper:

```typescript
// api/src/types/pagination.ts
interface PaginationParams {
  page: number;      // default 1
  limit: number;     // default 20, max 100
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

interface PaginatedResponse<T> {
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

Create `applyPagination(queryBuilder, params)` helper that applies `skip((page - 1) * limit)` and `take(limit)` to any TypeORM `SelectQueryBuilder`, and returns `{ data, meta }` after running `getManyAndCount()`.

Apply to all list endpoints:
- `GET /api/v1/chats` — sessions list
- `GET /api/v1/agents` — agents list
- `GET /api/v1/users` — users list
- `GET /api/v1/tenants` — tenants list
- `GET /api/v1/handoffs` — handoff queue
- `GET /api/v1/notifications` — notifications list

Each endpoint accepts `?page=1&limit=20&sortBy=createdAt&sortOrder=DESC` query params.

**Frontend — React Query integration:**

- Update `useChats` and other list hooks to accept `page`/`limit` params and expose `meta` in return value.
- Use React Query's `keepPreviousData` option for smooth page transitions.
- Create shared `<Pagination />` component (prev/next buttons + page indicator) used across all list views.
- Update service functions (`chatService`, etc.) to pass pagination params and parse the `meta` object from responses.

**Why page-based over cursor-based:**
Dataset sizes are moderate (sessions per tenant), several routes already use `offset`/`limit`, and page-based is simpler for the UI (page numbers, jump-to-page). Cursor-based would only matter at scale this project isn't at yet.

**Files affected:**
- New: `api/src/types/pagination.ts`, `api/src/utils/pagination.ts`
- New: `portal/src/components/ui/Pagination.tsx`
- Update: all list route handlers to use `applyPagination`
- Update: `portal/src/hooks/useChats.ts` and similar hooks
- Update: `portal/src/services/chatService.ts` and similar services

---

### #21 — TypeScript `any` Cleanup (163 instances)

**Priority:** 3 (Track 1)
**Effort:** Medium — incremental, low risk per change

**Strategy:** Incremental cleanup grouped by category, not file-by-file. This lets each batch be reviewed and merged independently.

**Batch 1 — Express request extensions (highest impact):**
Replace the global `any` types in `api/src/types/index.ts`:

```typescript
// Before
interface Request {
  user?: any;
  tenant?: any;
  widget?: any;
  session?: any;
}

// After
interface Request {
  user?: AuthenticatedUser;    // { id: string; clerkUserId: string; role: UserRole; ... }
  tenant?: TenantContext;       // { id: string; name: string; settings: TenantSettings; }
  widget?: WidgetContext;       // { tenantId: string; sessionId?: string; ... }
  session?: SessionContext;     // { id: string; tenantId: string; ... }
}
```

Define these interfaces based on what the auth/tenant middleware actually attaches to the request.

**Batch 2 — Socket middleware and handlers:**
Replace `as any` casts in `socket.handler.ts` with proper Socket.io typed events and middleware signatures.

**Batch 3 — Route handler parameters:**
Type `req.body`, `req.params`, `req.query` using per-route interfaces or generics from Express.

**Batch 4 — Service layer and utilities:**
Replace remaining `any` in service functions, utility helpers, and config types.

**Approach for each batch:**
1. `grep -r ': any\|as any' --include='*.ts'` to find instances in the batch scope
2. Trace actual runtime values to determine correct types
3. Define interfaces, replace `any`, fix downstream type errors
4. Compile check (`tsc --noEmit`) to verify

**Files affected:**
- `api/src/types/index.ts` — core request types
- `api/src/websocket/socket.handler.ts` — socket types
- Various route handlers and services — per-batch

---

## Track 2: Infrastructure

### #7 — WebSocket Rate Limiting Per Event

**Priority:** 1 (Track 2)
**Effort:** Small — wiring existing infrastructure

**Current state:**
`checkSocketRateLimit(socketId, tenantId?)` already exists in `rate-limit.middleware.ts` using Redis with in-memory fallback. But it's not called in any socket event handlers.

**Design:**

Create a socket middleware wrapper that rate-limits per event type:

```typescript
// api/src/websocket/socket-rate-limit.ts
const EVENT_LIMITS: Record<string, number> = {
  'message:send': 30,       // 30 messages per window
  'typing:indicator': 60,   // 60 typing events per window
  'file:upload': 10,        // 10 uploads per window
  'handoff:request': 5,     // 5 handoff requests per window
  // default: 100 per window (existing default)
};
```

Apply rate limiting in `socket.handler.ts` as a per-event middleware:
- Before processing each event, call `checkSocketRateLimit(socketId, tenantId)` with the event-specific point cost.
- If rate limit exceeded, emit an error event back to the client: `socket.emit('error', { code: 'RATE_LIMITED', event, retryAfter })`.
- Log rate limit violations for monitoring.

**What happens when limited:**
- Client receives `error` event with `RATE_LIMITED` code and `retryAfter` seconds.
- The event is silently dropped — no further processing.
- Widget/portal clients should handle this gracefully (show "slow down" message, disable send button briefly).

**Files affected:**
- New: `api/src/websocket/socket-rate-limit.ts`
- Update: `api/src/websocket/socket.handler.ts` — wire rate limit checks into event handlers
- Update: `api/src/middleware/rate-limit.middleware.ts` — extend `checkSocketRateLimit` to accept per-event point costs if not already supported

---

### #22 — Email Verification Flow (Clerk Sync)

**Priority:** 2 (Track 2)
**Effort:** Small — webhook handler + user entity sync

**Current state:**
- User entity has `emailVerified: boolean (default false)`.
- Clerk is the auth provider with `clerkUserId` on User entity.
- Clerk already handles email verification in its sign-up flow.
- No sync mechanism exists to update `emailVerified` in the local database.

**Design:**

**Option: Clerk webhook (recommended):**
- Register a Clerk webhook for `user.updated` events.
- Add endpoint `POST /api/v1/webhooks/clerk` that:
  1. Verifies the Clerk webhook signature (using `svix` library).
  2. On `user.updated` event, extracts `email_addresses[].verification.status`.
  3. Updates local User entity: `emailVerified = true` if Clerk reports verified.
- This keeps the local DB in sync automatically whenever a user verifies in Clerk.

**Fallback: sync on login:**
- In the existing auth middleware, after resolving `clerkUserId` to a local User, check Clerk's API for current verification status and update the local User if stale.
- This is simpler but only updates when the user logs in.

**Recommendation:** Implement the webhook as primary, with the login-time sync as a belt-and-suspenders fallback.

**Files affected:**
- New: `api/src/routes/webhook.routes.ts` — Clerk webhook handler
- Update: `api/src/middleware/auth.middleware.ts` — login-time sync fallback
- Update: `api/src/database/entities/User.ts` — no schema change needed (column exists)
- Package dependency: `svix` for webhook signature verification

---

### #19 — Test Infrastructure

**Priority:** 3 (Track 2)
**Effort:** Large — framework setup + initial test suite

**Current state:**
No test files, no test framework configured, no test scripts in package.json.

**Strategy:** API integration tests first, then backfill unit tests for critical utilities.

**Phase 1 — Test infrastructure setup:**

- **Framework:** Vitest (fast, TypeScript-native, compatible with the existing toolchain).
- **Test database:** Separate PostgreSQL database (e.g., `chatbot_test`) created via Docker Compose service or test setup script.
- **Test Redis:** Separate Redis instance or database index.
- **Setup/teardown:** Global setup creates DB schema via TypeORM `synchronize: true`, global teardown drops the test database.
- **Config:** `vitest.config.ts` with path aliases matching the existing `tsconfig.json`.

**Phase 2 — API integration tests (priority):**

Start with the most critical endpoints:
1. **Auth routes** — login, token refresh, webhook verification
2. **Chat routes** — create session, send message, get history (with pagination)
3. **Agent routes** — CRUD, status updates, assignment
4. **Handoff routes** — request, accept, reject flow

Each test:
- Spins up Express app with real middleware
- Seeds test data via TypeORM
- Makes HTTP requests via `supertest`
- Asserts response status, body shape, and side effects (DB state)
- Cleans up after itself (truncate tables between tests)

**Phase 3 — Unit tests (backfill):**

Target high-value utilities:
- Message encryption/decryption (`encryption.util.ts`)
- Rate limiting logic (`rate-limit.middleware.ts`)
- Pagination helper (`pagination.ts` — once created in #20)
- WebSocket auth middleware

**Files affected:**
- New: `api/vitest.config.ts`
- New: `api/src/__tests__/setup.ts` — global test setup/teardown
- New: `api/src/__tests__/integration/` — integration test files
- New: `api/src/__tests__/unit/` — unit test files
- Update: `api/package.json` — add vitest, supertest as dev dependencies, add `test` script
- New: Docker Compose test service or test DB setup script

---

## Implementation Order

### Track 1: Data Layer
```
#23 Participant soft-delete
  → #20 Pagination on lists (can reference soft-delete filters)
    → #21 any cleanup (benefits from types created in #20)
```

### Track 2: Infrastructure
```
#7 WebSocket rate limiting
  → #22 Email verification (Clerk sync)
    → #19 Test infrastructure (can test all the above)
```

Tracks 1 and 2 are independent and can be worked in parallel. Within each track, issues are ordered by dependency and value.

---

## Design Decisions Summary

| Issue | Approach | Key Decision |
|-------|----------|-------------|
| #23 | Soft-delete with GDPR metadata anonymization | Matches existing Message pattern |
| #20 | Page-based pagination with shared helper | Cursor-based deferred until needed |
| #21 | Batched by category (request types → sockets → routes → services) | Not file-by-file |
| #7 | Per-event rate limits using existing Redis infrastructure | Event-specific thresholds |
| #22 | Clerk webhook + login-time fallback | No custom email flow needed |
| #19 | Vitest + supertest, integration tests first | Unit tests backfill critical utils |
