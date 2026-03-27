# Phase 2: Automated Tests Spec

> First sub-project of Phase 2 (Testing & Reliability): write integration tests for critical flows and set up CI to enforce them.

---

## 1. CI Pipeline (GitHub Actions)

### What

A single workflow file `.github/workflows/test.yml` that runs on every push to `main` and on pull requests.

### Jobs

**test** job:
- Runs on `ubuntu-latest`
- PostgreSQL 15 service container (port 5432 inside the runner, mapped via service hostname `postgres`)
- Steps:
  1. Checkout code
  2. Setup Node.js (match project version from `.nvmrc` or `package.json engines`, fallback to 20)
  3. `npm ci` in `api/`
  4. `npm ci` in `portal/`
  5. `npx tsc --noEmit` in `api/` (type-check gate)
  6. `npx tsc --noEmit` in `portal/` (type-check gate)
  7. `npx vitest run` in `api/` with `TEST_DATABASE_URL` pointing at the service container
  8. `npm run build` in `portal/` (build gate)

### Environment Variables

The workflow sets these for the test step:
- `TEST_DATABASE_URL=postgresql://test:test@postgres:5432/chatbot_test`
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

## 2. Phase 1 Debt Tests (11 scenarios)

### 2a. Deactivation + Session Cleanup

**File:** `api/src/__tests__/integration/deactivation.test.ts` (new)

Uses factories to create a tenant, user, agent, and sessions, then calls the deactivation endpoint and verifies DB state.

**Tests:**
1. **Deactivate user with active sessions** — Create user + agent + 2 sessions (status `active` and `handoff`). Call `POST /admin/users/:id/deactivate`. Assert both sessions now have `status = 'waiting'` and `assignedAgentId = null`.
2. **Deactivate user with accepted handoff requests** — Create user + agent + handoff request (status `accepted`, `assignedAgentId = agent.id`). Deactivate. Assert handoff request now has `status = 'requested'` and `assignedAgentId = null`.
3. **Deactivate user with no agent record** — Create user with role `admin` (no agent entity). Deactivate. Assert success response, user `isActive = false`.

All tests use `mockClerkAuth()` with super-admin context.

### 2b. Super-Admin Invite Resend/Cancel

**File:** `api/src/__tests__/integration/admin.test.ts` (extend existing)

**Tests:**
4. **Resend invite — happy path** — Create tenant + pending invite. Call `POST /admin/tenants/:id/pending-invites/:inviteId/resend`. Assert response contains invite with `expiresAt` in the future (> now).
5. **Resend invite — not found** — Call resend with non-existent invite ID. Assert 404.
6. **Cancel invite — happy path** — Create tenant + pending invite. Call `DELETE /admin/tenants/:id/pending-invites/:inviteId`. Assert 204. Verify invite no longer in DB.
7. **Cancel invite — not found** — Call cancel with non-existent invite ID. Assert 404.

Note: Clerk calls need to be mocked/stubbed since there's no Clerk org in tests. The `inviteToClerkOrganization` function should be mocked to return `true`.

### 2c. Audit Log Fixes

**File:** `api/src/__tests__/integration/audit.test.ts` (new)

**Tests:**
8. **Audit logs include tenant name** — Create tenant + audit log entry with that tenant's ID. Call `GET /admin/audit-logs`. Assert response contains `tenantName` matching the tenant's name.
9. **Date range includes full end day** — Create audit log at 2026-03-27T15:00:00Z. Call `GET /admin/audit-logs?to=2026-03-27`. Assert the log is included in results.
10. **CSV export includes tenant_name column** — Create tenant + audit log. Call `GET /admin/audit-logs/export`. Assert response is CSV text, header contains `tenant_name`, row contains the tenant's name.
11. **Pagination returns correct meta** — Create 30 audit logs. Call `GET /admin/audit-logs?page=1&limit=10`. Assert response meta has `total = 30`, `totalPages = 3`, `page = 1`.

---

## 3. Critical Path Tests (~15 scenarios)

### 3a. Chat Session Lifecycle

**File:** `api/src/__tests__/integration/chat.test.ts` (extend existing)

**Tests:**
12. **Create session via widget auth** — Create tenant with API key. Call `POST /auth/widget` with the key. Assert returns session token/ID.
13. **Send message to session** — Create session + send message via `POST /chat/:sessionId/message`. Assert message stored in DB.
14. **Get chat history with pagination** — Create session + 15 messages. Call `GET /chat/:sessionId/history?limit=10`. Assert returns 10 messages with pagination info.
15. **Close session** — Create active session. Call `POST /chat/:sessionId/close`. Assert session status is `closed`.

### 3b. Handoff Flow

**File:** `api/src/__tests__/integration/handoff.test.ts` (extend existing)

**Tests:**
16. **Request handoff** — Create session in `bot` status. Call `POST /handoff/request`. Assert handoff request created with status `requested`.
17. **Accept handoff** — Create pending handoff request + online agent. Call `POST /handoff/accept`. Assert request status is `accepted`, `assignedAgentId` set.
18. **Reject handoff** — Create pending handoff. Call `POST /handoff/reject` with reason. Assert status `rejected`, reason stored.
19. **Get handoff queue** — Create 3 handoff requests (2 pending, 1 accepted). Call `GET /handoff/queue`. Assert returns only the 2 pending ones.

### 3c. Agent Management

**File:** `api/src/__tests__/integration/agents.test.ts` (extend existing)

**Tests:**
20. **List agents** — Create tenant + 3 agents. Call `GET /agents`. Assert returns 3 agents scoped to tenant.
21. **Create agent** — Call `POST /agents` with valid data. Assert agent created with status `offline`.
22. **Update agent status** — Create agent. Call `PATCH /agents/:id/status` with `{ status: 'online' }`. Assert status changed.
23. **Delete agent** — Create agent. Call `DELETE /agents/:id`. Assert `deletedAt` is set (soft delete).

### 3d. Tenant Management

**File:** `api/src/__tests__/integration/tenant.test.ts` (extend existing)

**Tests:**
24. **Get tenant config** — Create tenant. Call `GET /tenants/:id`. Assert returns tenant details.
25. **Update tenant webhook URL** — Call `PATCH /tenants/:id` with new webhook URL. Assert persisted.
26. **Rotate API key** — Call `POST /tenants/:id/api-keys`. Assert returns new masked key, old key no longer valid.

---

## 4. Test Helpers Needed

The existing factories in `api/src/__tests__/helpers/factories.ts` cover entity creation. Additional helpers may be needed:

- **`createTestAuditLog()`** — factory for seeding audit log entries with specific tenantId, action, and createdAt.
- **`createTestPendingInvite()`** — factory for seeding pending invite records.
- **`createTestHandoffRequest()`** — factory for seeding handoff requests with specific status and agent assignment.
- **Mock for `inviteToClerkOrganization`** — stub that returns `true` so invite resend tests don't call real Clerk API.
- **Mock for `removeFromClerkOrganization`** — stub that returns `true` so deactivation tests don't call real Clerk API.

These follow the existing factory pattern (use `AppDataSource.getRepository()` to save entities directly).

---

## Summary

| # | Item | Tests | File |
|---|------|-------|------|
| 1 | CI pipeline | — | `.github/workflows/test.yml` |
| 2a | Deactivation cleanup | 3 | `deactivation.test.ts` (new) |
| 2b | Invite resend/cancel | 4 | `admin.test.ts` (extend) |
| 2c | Audit log fixes | 4 | `audit.test.ts` (new) |
| 3a | Chat lifecycle | 4 | `chat.test.ts` (extend) |
| 3b | Handoff flow | 4 | `handoff.test.ts` (extend) |
| 3c | Agent management | 4 | `agents.test.ts` (extend) |
| 3d | Tenant management | 3 | `tenant.test.ts` (extend) |
| 4 | Test helpers | — | `factories.ts` + mocks |

**Total: ~26 new integration tests + CI pipeline.**
