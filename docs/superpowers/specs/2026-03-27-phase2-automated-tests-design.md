# Phase 2: Automated Tests Spec

> First sub-project of Phase 2 (Testing & Reliability): write integration tests for critical flows and set up CI to enforce them.

---

## 1. CI Pipeline (GitHub Actions)

### What

A single workflow file `.github/workflows/test.yml` that runs on every push to `main` and on pull requests.

### Jobs

**test** job:
- Runs on `ubuntu-latest`
- PostgreSQL 15 service container (port 5432, accessed via `localhost` from the runner)
- Steps:
  1. Checkout code
  2. Setup Node.js 20 (`package.json` engines says `>=18.0.0`, no `.nvmrc` — use 20 as stable LTS)
  3. `npm ci` in `api/`
  4. `npm ci` in `portal/`
  5. `npx tsc --noEmit` in `api/` (type-check gate)
  6. `npx tsc --noEmit` in `portal/` (type-check gate)
  7. `npx vitest run` in `api/` with `TEST_DATABASE_URL` pointing at `localhost`
  8. `npm run build` in `portal/` (build gate)

### Environment Variables

The workflow sets these for the test step:
- `TEST_DATABASE_URL=postgresql://test:test@localhost:5432/chatbot_test`
- `JWT_SECRET=test-jwt-secret`
- `ENCRYPTION_KEY=0123456789abcdef0123456789abcdef`
- `NODE_ENV=test`
- `CLERK_SECRET_KEY=test_clerk_key`
- `CLERK_WEBHOOK_SECRET=test_webhook_secret`
- `SUPER_ADMIN_EMAILS=test@example.com`

### PostgreSQL Service

```yaml
services:
  postgres:
    image: postgres:15-alpine
    env:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: chatbot_test
    ports:
      - 5432:5432
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

No Redis service needed — tests mock/skip socket and cache layers.

---

## 2. Test Infrastructure Fixes

### 2a. Upgrade `mockClerkAuth()`

**File:** `api/src/__tests__/helpers/auth.ts`

The current helper hardcodes `role: 'admin'` and uses non-UUID strings for `tenantId`/`userId`/`agentId`. This breaks routes that validate tenant existence or require `super_admin` role.

**Fix:** Accept overrides for role, tenantId, userId, and agentId. Default to valid UUIDs. The mock must be installed before the `app` module is imported (since Clerk middleware runs at import time).

```typescript
interface MockAuthOptions {
  role?: string;       // default: 'super_admin'
  tenantId?: string;   // default: a valid UUID
  userId?: string;     // default: a valid UUID
  agentId?: string;    // default: a valid UUID
}
```

### 2b. Fix `createTestSession()` factory

**File:** `api/src/__tests__/helpers/factories.ts`

The factory doesn't set `startedAt` or `lastActivityAt`, but these are required fields on `ChatSession`. Tests use `synchronize()` (not migrations), so DB defaults don't apply. Add these fields with `new Date()` defaults.

### 2c. New factories

Add to `api/src/__tests__/helpers/factories.ts`:
- **`createTestAuditLog(overrides?)`** — seeds audit log with tenantId, actorId, action, createdAt
- **`createTestPendingInvite(overrides?)`** — seeds pending invite with tenantId, email, role, expiresAt
- **`createTestHandoffRequest(overrides?)`** — seeds handoff request with sessionId, tenantId, status, assignedAgentId

### 2d. Clerk service mocks

**File:** `api/src/__tests__/helpers/clerk-mocks.ts` (new)

Mock `inviteToClerkOrganization` and `removeFromClerkOrganization` to return `true`. These must be set up with `vi.mock()` before the app module loads. Provide a helper that test files can import.

---

## 3. Phase 1 Debt Tests (11 scenarios + 3 edge cases)

All endpoint paths use the `/api/v1/` prefix (e.g., `POST /api/v1/admin/users/:id/deactivate`).

### 3a. Deactivation + Session Cleanup

**File:** `api/src/__tests__/integration/deactivation.test.ts` (new)

**Tests:**
1. **Deactivate user with active sessions** — Create user + agent + 2 sessions (status `active` and `handoff`). Call `POST /api/v1/admin/users/:id/deactivate`. Assert both sessions now have `status = 'waiting'` and `assignedAgentId = null`.
2. **Deactivate user with accepted handoff requests** — Create user + agent + handoff request (status `accepted`, `assignedAgentId = agent.id`). Deactivate. Assert handoff request now has `status = 'requested'` and `assignedAgentId = null`.
3. **Deactivate user with no agent record** — Create user with role `admin` (no agent entity). Deactivate. Assert success response, user `isActive = false`.
4. **Deactivate already-inactive user returns 400** — Create user, set `isActive = false`. Deactivate. Assert 400.
5. **Cannot deactivate yourself returns 400** — Mock auth with userId matching the target. Deactivate. Assert 400.
6. **Cannot deactivate last active admin (tenant-level)** — Create tenant with one admin. Call `POST /api/v1/tenants/me/users/:userId/deactivate`. Assert 400.

All tests use `mockClerkAuth()` with `super_admin` role and valid UUIDs. Clerk service mocks stub `removeFromClerkOrganization` to return `true`.

### 3b. Super-Admin Invite Resend/Cancel

**File:** `api/src/__tests__/integration/admin.test.ts` (extend existing)

**Tests:**
7. **Resend invite — happy path** — Create tenant (with `clerkOrgId` set) + pending invite. Call `POST /api/v1/admin/tenants/:id/pending-invites/:inviteId/resend`. Assert response contains invite with `expiresAt` in the future (> now).
8. **Resend invite — not found** — Call resend with non-existent invite UUID. Assert 404.
9. **Cancel invite — happy path** — Create tenant + pending invite. Call `DELETE /api/v1/admin/tenants/:id/pending-invites/:inviteId`. Assert 204. Verify invite no longer in DB.
10. **Cancel invite — not found** — Call cancel with non-existent invite UUID. Assert 404.

Clerk service mocks stub `inviteToClerkOrganization` to return `true`.

### 3c. Audit Log Fixes

**File:** `api/src/__tests__/integration/audit.test.ts` (new)

**Tests:**
11. **Audit logs include tenant name** — Create tenant + audit log entry with that tenant's ID. Call `GET /api/v1/admin/audit-logs`. Assert response body contains `tenantName` matching the tenant's name.
12. **Date range includes full end day** — Create audit log at 2026-03-27T15:00:00Z. Call `GET /api/v1/admin/audit-logs?to=2026-03-27`. Assert the log is included in results.
13. **CSV export includes tenant_name column** — Create tenant + audit log. Call `GET /api/v1/admin/audit-logs/export`. Assert response is CSV text, header contains `tenant_name`, row contains the tenant's name.
14. **Pagination returns correct meta** — Create 30 audit logs. Call `GET /api/v1/admin/audit-logs?page=1&limit=10`. Assert response `meta.pagination` has `total = 30`, `totalPages = 3`, `page = 1`.

---

## 4. Critical Path Tests (~16 scenarios)

### 4a. Chat Session Lifecycle

**File:** `api/src/__tests__/integration/chat.test.ts` (extend existing)

**Tests:**
15. **Create session via widget auth** — Create tenant with API key. Call `POST /api/v1/auth/widget` with the key. Assert returns session token.
16. **Widget init** — Create tenant. Call `POST /api/v1/widget/init` with tenant ID. Assert returns session/config data.
17. **Send message to session** — Create session. Call `POST /api/v1/chats/:sessionId/message`. Assert message returned via `GET /api/v1/chats/:sessionId/history` (don't assert DB directly — messages are encrypted).
18. **Get chat history with pagination** — Create session + 15 messages via the API. Call `GET /api/v1/chats/:sessionId/history?limit=10`. Assert returns 10 messages with `pagination` info in response.
19. **Close session** — Create active session. Call `POST /api/v1/chats/:sessionId/close`. Assert session status is `closed`.

### 4b. Handoff Flow

**File:** `api/src/__tests__/integration/handoff.test.ts` (extend existing)

Uses the DB-backed handoff endpoints (not the socket-based ones):

**Tests:**
20. **Request handoff** — Create session + handoff request via factory. Verify request has status `requested` via `GET /api/v1/handoffs/queue`.
21. **Accept handoff** — Create pending handoff request + online agent. Call `POST /api/v1/handoffs/:id/accept`. Assert request status is `accepted`, `assignedAgentId` set.
22. **Decline handoff** — Create pending handoff. Call `POST /api/v1/handoffs/:id/decline`. Assert status `rejected`.
23. **Get handoff queue** — Create 3 handoff requests (2 `requested`, 1 `accepted`). Call `GET /api/v1/handoffs/queue`. Assert returns only the 2 pending ones.

### 4c. Agent Management

**File:** `api/src/__tests__/integration/agents.test.ts` (extend existing)

Note: there is no `DELETE /agents/:id` endpoint. Tests cover what exists.

**Tests:**
24. **List agents** — Create tenant + 3 agents. Call `GET /api/v1/agents`. Assert returns agents scoped to tenant.
25. **Create agent** — Call `POST /api/v1/agents` with valid data. Assert agent created with status `offline`.
26. **Update agent status** — Create agent. Call `PATCH /api/v1/agents/:id/status` with `{ status: 'online' }`. Assert status changed.

### 4d. Tenant Management

**File:** `api/src/__tests__/integration/tenant.test.ts` (extend existing)

Tenant self-service routes are under `/api/v1/tenants/me`, not `/tenants/:id`.

**Tests:**
27. **Get tenant config** — Create tenant. Call `GET /api/v1/tenants/me`. Assert returns tenant details.
28. **Update tenant webhook URL** — Call `PATCH /api/v1/tenants/me` with new webhook URL. Assert persisted.
29. **Rotate API key** — Call `POST /api/v1/admin/tenants/:id/api-key/rotate`. Assert returns new raw `apiKey` (not masked — masking only on tenant detail endpoint).
30. **Widget config** — Create tenant. Call `GET /api/v1/widget/config/:tenantId`. Assert returns widget configuration.

---

## Summary

| # | Item | Tests | File |
|---|------|-------|------|
| 1 | CI pipeline | — | `.github/workflows/test.yml` |
| 2 | Test infra fixes | — | `auth.ts`, `factories.ts`, `clerk-mocks.ts` |
| 3a | Deactivation cleanup + edge cases | 6 | `deactivation.test.ts` (new) |
| 3b | Invite resend/cancel | 4 | `admin.test.ts` (extend) |
| 3c | Audit log fixes | 4 | `audit.test.ts` (new) |
| 4a | Chat lifecycle + widget | 5 | `chat.test.ts` (extend) |
| 4b | Handoff flow | 4 | `handoff.test.ts` (extend) |
| 4c | Agent management | 3 | `agents.test.ts` (extend) |
| 4d | Tenant management + widget config | 4 | `tenant.test.ts` (extend) |

**Total: ~30 new integration tests + CI pipeline + test infra fixes.**
