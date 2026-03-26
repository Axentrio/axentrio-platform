# Phase 2: Testing & Reliability — Design Spec

> Automated testing for the chatbot platform API using Vitest + TypeScript with integration tests against a real Postgres database.

---

## Goals

1. Establish a test infrastructure (Vitest, Docker Postgres, CI pipeline) that's easy to extend
2. Cover critical paths first: auth, chat, handoff, admin, tenants, files, agents
3. Run tests automatically on every PR via GitHub Actions

## Non-Goals

- Frontend (portal) tests — separate effort (Vitest + React Testing Library)
- WebSocket/Socket.io real-time tests
- E2E browser tests (Playwright/Cypress)
- Error monitoring (Sentry) and DB backups — separate items

---

## Test Infrastructure

### Framework & Config

- **Vitest** — already installed and configured in the project (`api/vitest.config.ts`)
- Path aliases already mapped in the existing Vitest config
- Test files: `api/src/__tests__/**/*.test.ts`
- Scripts in `api/package.json`:
  - `test` — already exists (`vitest run`)
  - `test:coverage` — needs to be added (`vitest run --coverage`)
- **Coverage threshold:** 40% line coverage minimum for the initial pass, enforced in config

### Database

- **Docker Postgres 15** via `api/docker-compose.test.yml` (single service, port 5433)
- **Connection:** `setup.ts` reads `DATABASE_URL` from `process.env`. Locally this is set via `.env.test` (pointing to port 5433); in CI it's set via the workflow `env:` block (pointing to port 5432 from the GitHub Actions service container).
- **Vitest config change:** The existing `vitest.config.ts` uses `setupFiles` (runs before each test file). This must be changed to `globalSetup` (runs once before the entire suite) and `globalTeardown` (runs once after). This is critical — using `setupFiles` would re-run migrations and create duplicate DataSource instances per test file.
- Global setup (`api/src/__tests__/setup.ts`):
  - Initializes TypeORM DataSource against the test DB using `DATABASE_URL`
  - Runs all migrations once
  - Exports shared DataSource for test files via a singleton
- Global teardown (`api/src/__tests__/teardown.ts`):
  - Drops test database tables
  - Closes DataSource connection
- **Test isolation:** Each test file wraps operations in a transaction and rolls back after. Tests within a single file share that transaction and can see each other's writes. If intra-file isolation is needed, use savepoints.

### Test Helpers

- `api/src/__tests__/helpers.ts`:
  - `createTestTenant()` — inserts a tenant with defaults
  - `createTestUser(tenantId, overrides?)` — inserts a user
  - `createTestAgent(tenantId, userId)` — inserts an agent
  - `createTestSession(tenantId)` — inserts a chat session
  - `getAuthHeaders(user)` — generates a valid JWT for request auth
  - `buildApp()` — creates an Express app instance with all routes mounted (no `.listen()`)

### `buildApp()` Dependency Strategy

The test app needs careful handling of external dependencies:

| Dependency | Strategy |
|-----------|----------|
| **TypeORM / Postgres** | Connects to the test DB (initialized in `setup.ts`) |
| **Clerk auth middleware** | Bypassed — `getAuthHeaders()` generates valid JWTs directly; Clerk SDK calls are mocked via `vi.mock()` |
| **Redis** | Mocked — tests don't need caching or Bull queues. Graceful fallback already exists in the codebase. |
| **S3 (file uploads)** | Mocked — `vi.mock()` on the S3 client; pre-signed URL generation returns deterministic test URLs |
| **n8n services** | Stubbed — `initializeForwarding()` is a no-op in test mode; outbound webhook calls are mocked |
| **ClamAV** | Mocked — virus scan always returns clean |

### Request Testing

- **supertest** for HTTP assertions against the Express app
- No server `.listen()` needed — supertest binds directly to the Express instance

---

## Test Coverage Plan

### Unit Tests

Test pure functions and services in isolation, mocking external dependencies.

| File | What to test |
|------|-------------|
| `utils/audit.ts` | `logAudit()` creates AuditLog record with correct fields |
| `utils/encryption.ts` | Encrypt/decrypt roundtrip, handles empty strings, different key lengths |
| `utils/pagination.ts` | `parsePaginationParams()` — defaults, clamping, invalid input |
| `services/clerk-sync.service.ts` | Org creation, member add/remove (mock Clerk SDK) |
| `n8n/circuit-breaker.ts` | State transitions (closed → open → half-open), failure threshold, reset behavior |
| `n8n/retry.service.ts` | Exponential backoff timing, max retry limit, success on retry |

### Integration Tests

Test API routes end-to-end through HTTP with a real Postgres database.

| Route group | Route file | Key test cases |
|-------------|-----------|---------------|
| **Auth** (`/api/v1/auth`) | `auth.routes.ts` | Widget auth with valid/invalid API key; agent login with valid/invalid credentials; token refresh; logout |
| **Chat** (`/api/v1/chats`) | `chat.routes.ts` | Send message and retrieve in history; get session status; close session; edit message; pagination of history |
| **Handoff** (`/api/v1/handoffs`) | `handsoff.routes.ts` (note: filename typo in codebase) | Request handoff; accept (assigns agent); reject; list pending; double-accept prevention |
| **Admin** (`/api/v1/admin`) | `admin.routes.ts` | List tenants with pagination; create tenant; suspend/activate; tenant detail; audit log list with filters; audit log CSV export |
| **Tenant** (`/api/v1/tenants`) | `tenants.ts` | Get own tenant; update settings; invite user; list pending invites; resend/cancel invite; deactivate/reactivate member |
| **Agents** (`/api/v1/agents`) | `agents.routes.ts` | List agents; update status; get metrics; update availability; tenant isolation |
| **File** (`/api/v1/files`) | `files.routes.ts` | Request pre-signed upload URL; get file metadata; delete file |
| **Clerk Webhook** (`/api/v1/clerk`) | `clerk-webhook.routes.ts` | Valid webhook signature accepted; invalid signature rejected; user created/updated events processed correctly |
| **Health** (`/health`) | — | Returns 200 with expected shape |

#### Deferred (lower priority, add later)

| Route file | Reason for deferral |
|-----------|-------------------|
| `users.routes.ts` | Overlaps heavily with tenant user management already tested |
| `analytics.routes.ts` | Read-only aggregation queries; low risk of regression |
| `notifications.routes.ts` | Thin CRUD; low complexity |
| `webhook-admin.routes.ts` | Admin-only webhook config; low traffic |
| `widget.ts` | Mostly proxies to other services; covered indirectly by auth tests |

### Auth & Middleware Tests

- Requests without auth token return 401
- Requests with expired token return 401
- Tenant isolation: user from tenant A cannot access tenant B's data
- Rate limiting: exceeding limit returns 429
- Role-based access: agent cannot hit admin endpoints (403)

---

## CI Pipeline

### New Workflow: `.github/workflows/test.yml`

```yaml
name: Tests
on:
  pull_request:
    branches: [main]
    paths:
      - 'chatbot-platform/api/**'

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
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

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: chatbot-platform/api/package-lock.json
      - run: cd chatbot-platform/api && npm ci
      - run: cd chatbot-platform/api && npx vitest run --coverage
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/chatbot_test
          JWT_SECRET: test-secret
          ENCRYPTION_KEY: 0123456789abcdef0123456789abcdef
          NODE_ENV: test
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage-report
          path: chatbot-platform/api/coverage/
```

**Trigger:** PRs targeting `main` that touch `chatbot-platform/api/**`
**Blocks merge:** Yes — required status check

---

## File Structure

### New Files

```
api/
├── docker-compose.test.yml
├── .env.test                       # DATABASE_URL=postgresql://test:test@localhost:5433/chatbot_test
├── src/__tests__/
│   ├── setup.ts                    # Global setup (reads DATABASE_URL from env, runs migrations)
│   ├── teardown.ts                 # Global teardown (drops tables, closes connection)
│   ├── helpers.ts                  # Test factories and utilities
│   ├── unit/
│   │   ├── audit.test.ts
│   │   ├── encryption.test.ts
│   │   ├── pagination.test.ts
│   │   ├── clerk-sync.test.ts
│   │   ├── circuit-breaker.test.ts
│   │   └── retry-service.test.ts
│   └── integration/
│       ├── auth.test.ts
│       ├── chat.test.ts
│       ├── handoff.test.ts
│       ├── admin.test.ts
│       ├── tenant.test.ts
│       ├── agents.test.ts
│       ├── clerk-webhook.test.ts
│       ├── file.test.ts
│       └── health.test.ts
.github/workflows/
└── test.yml
```

### Modified Files

- `api/package.json` — add `supertest`, `@types/supertest`, and `@vitest/coverage-v8` as dev dependencies; add `test:coverage` script
- `api/vitest.config.ts` — change `setupFiles` to `globalSetup`/`globalTeardown`; add coverage threshold config
- `api/tsconfig.json` — ensure `__tests__` directory is excluded from build but included in IDE support
- `api/.env.test` — committed to repo (contains only localhost test credentials, no secrets)

---

## Dependencies

**New dev dependencies:**
- `supertest` — HTTP assertions
- `@types/supertest` — type definitions
- `@vitest/coverage-v8` — coverage provider (Vitest does not include one by default; `vitest run --coverage` will fail without it)

(Vitest itself is already installed.)

---

## Decisions & Trade-offs

| Decision | Rationale |
|----------|-----------|
| Vitest (keep existing) | Already installed and configured with path aliases; no migration needed |
| Docker Postgres over SQLite | Avoids query compatibility issues between test and production |
| Transaction rollback over truncate | Faster test execution, no need to reseed |
| supertest over real HTTP | No port conflicts, faster, no server lifecycle management |
| Critical paths first | Maximizes safety net per test written |
| No WebSocket tests yet | Requires Socket.io test client setup; lower ROI for initial pass |
| 40% initial coverage threshold | Prevents regressions without being unreachable; increase over time |
| `DATABASE_URL` from env | Same config works locally (port 5433) and in CI (port 5432) |
