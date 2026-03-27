# Phase 2: Automated Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ~30 integration tests for critical API flows and set up GitHub Actions CI to run them on every push/PR.

**Architecture:** Tests use Vitest + Supertest against the Express app with a real PostgreSQL database. Clerk auth is mocked via top-level `vi.mock()` + `vi.hoisted()` in each test file. Each test file truncates all tables after each test via the existing `setup.ts`. CI runs PostgreSQL as a service container.

**Tech Stack:** Vitest, Supertest, PostgreSQL 15, GitHub Actions, TypeORM

**Key patterns:**
- `vi.hoisted()` creates shared auth state accessible to mock factories
- Top-level `vi.mock()` calls (Vitest hoists these before imports)
- `configureMockAuth()` updates auth state between tests
- Chat history/close routes use widget auth (the widget middleware matches first in Express routing)
- Response envelope is `{ success, data, meta? }` via `sendSuccess()`, but inner shapes vary per endpoint

---

### Task 1: GitHub Actions CI Workflow

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Create the workflow file**

The repo root is one level above `chatbot-platform/`, so working-directory paths need the prefix.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

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

    env:
      TEST_DATABASE_URL: postgresql://test:test@localhost:5432/chatbot_test
      JWT_SECRET: test-jwt-secret-for-ci
      ENCRYPTION_KEY: 0123456789abcdef0123456789abcdef
      NODE_ENV: test
      CLERK_SECRET_KEY: test_clerk_key
      CLERK_WEBHOOK_SECRET: test_webhook_secret
      SUPER_ADMIN_EMAILS: test@example.com

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: |
            chatbot-platform/api/package-lock.json
            chatbot-platform/portal/package-lock.json

      - name: Install API dependencies
        working-directory: chatbot-platform/api
        run: npm ci

      - name: Install Portal dependencies
        working-directory: chatbot-platform/portal
        run: npm ci

      - name: Type-check API
        working-directory: chatbot-platform/api
        run: npx tsc --noEmit

      - name: Type-check Portal
        working-directory: chatbot-platform/portal
        run: npx tsc --noEmit

      - name: Run API tests
        working-directory: chatbot-platform/api
        run: npx vitest run

      - name: Build Portal
        working-directory: chatbot-platform/portal
        run: npm run build
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add GitHub Actions workflow with Postgres service"
```

---

### Task 2: Auth Mock Infrastructure + Factory Fixes

**Files:**
- Modify: `api/src/__tests__/helpers/auth.ts`
- Modify: `api/src/__tests__/helpers/factories.ts`

- [ ] **Step 1: Rewrite auth.ts with hoisted mock pattern**

Replace the entire content of `api/src/__tests__/helpers/auth.ts`:

```typescript
import { vi } from 'vitest';

/**
 * Auth mock infrastructure for integration tests.
 *
 * Usage in each test file (MUST be at the top, before app import):
 *
 *   import { createAuthMocks, configureMockAuth } from '../helpers/auth';
 *   const { auth } = createAuthMocks();
 *   import { app } from '../../server';
 *
 * Then in beforeEach:
 *   configureMockAuth(auth, { userId: '...', role: 'super_admin' });
 */

export interface MockAuthState {
  userId: string;
  tenantId: string;
  agentId: string;
  role: string;
  email: string;
  clerkUserId: string;
  clerkOrgId: string;
}

/**
 * Create all vi.mock() calls and return the hoisted auth state.
 * MUST be called at top of test file before any app/server import.
 */
export function createAuthMocks() {
  const auth = vi.hoisted((): MockAuthState => ({
    userId: '',
    tenantId: '',
    agentId: '',
    role: 'super_admin',
    email: 'test@example.com',
    clerkUserId: '',
    clerkOrgId: '',
  }));

  vi.mock('../../middleware/clerk.middleware', () => ({
    requireClerkAuth: (req: any, _res: any, next: any) => {
      req.userId = auth.userId;
      req.tenantId = auth.tenantId;
      req.agentId = auth.agentId;
      req.user = {
        id: auth.userId,
        email: auth.email,
        role: auth.role,
        tenantId: auth.tenantId,
        clerkUserId: auth.clerkUserId,
        type: 'agent',
      };
      next();
    },
    autoProvision: (_req: any, _res: any, next: any) => next(),
    invalidateProvisionCache: () => {},
    resolveClerkIds: () => ({}),
  }));

  vi.mock('../../middleware/super-admin.middleware', () => ({
    requireSuperAdmin: (req: any, res: any, next: any) => {
      if (req.user?.role !== 'super_admin') {
        res.status(403).json({ error: 'Super admin access required' });
        return;
      }
      next();
    },
    resolveTenantContext: (_req: any, _res: any, next: any) => next(),
  }));

  vi.mock('../../services/clerk-sync.service', () => ({
    inviteToClerkOrganization: () => Promise.resolve(true),
    removeFromClerkOrganization: () => Promise.resolve(true),
  }));

  return { auth };
}

/**
 * Update auth state for the next request.
 * Call in beforeEach or before a specific request.
 */
export function configureMockAuth(
  auth: MockAuthState,
  options: Partial<MockAuthState> = {},
): MockAuthState {
  const defaults: Partial<MockAuthState> = {
    role: 'super_admin',
    email: 'test@example.com',
  };
  Object.assign(auth, defaults, options);
  return auth;
}
```

- [ ] **Step 2: Fix createTestSession factory**

In `api/src/__tests__/helpers/factories.ts`, replace the `createTestSession` function with:

```typescript
export async function createTestSession(
  tenantId: string,
  overrides: Partial<ChatSession> = {},
): Promise<ChatSession> {
  const repo = AppDataSource.getRepository(ChatSession);
  return repo.save(
    repo.create({
      tenantId,
      visitorId: `visitor-${crypto.randomBytes(4).toString('hex')}`,
      status: 'active',
      source: 'widget',
      messageCount: 0,
      unreadCount: 0,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      ...overrides,
    }),
  );
}
```

- [ ] **Step 3: Add new factories**

Add these imports at the top of `api/src/__tests__/helpers/factories.ts`:

```typescript
import { AuditLog } from '../../database/entities/AuditLog';
import { PendingInvite } from '../../database/entities/PendingInvite';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
```

Then add these functions at the bottom:

```typescript
export async function createTestAuditLog(overrides: Partial<AuditLog> = {}): Promise<AuditLog> {
  const repo = AppDataSource.getRepository(AuditLog);
  return repo.save(
    repo.create({
      actorId: crypto.randomUUID(),
      action: 'test.action',
      entityType: 'test',
      entityId: crypto.randomUUID(),
      ...overrides,
    }),
  );
}

export async function createTestPendingInvite(
  tenantId: string,
  overrides: Partial<PendingInvite> = {},
): Promise<PendingInvite> {
  const repo = AppDataSource.getRepository(PendingInvite);
  return repo.save(
    repo.create({
      tenantId,
      email: `invite-${crypto.randomBytes(4).toString('hex')}@test.com`,
      role: 'agent',
      invitedBy: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ...overrides,
    }),
  );
}

export async function createTestHandoffRequest(
  sessionId: string,
  tenantId: string,
  overrides: Partial<HandoffRequest> = {},
): Promise<HandoffRequest> {
  const repo = AppDataSource.getRepository(HandoffRequest);
  return repo.save(
    repo.create({
      sessionId,
      tenantId,
      requestedBy: crypto.randomUUID(),
      requestedAt: new Date(),
      status: 'requested',
      reason: 'user_request',
      priority: 'medium',
      ...overrides,
    }),
  );
}
```

- [ ] **Step 4: Verify compilation**

Run: `cd api && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 5: Commit**

```bash
git add api/src/__tests__/helpers/auth.ts api/src/__tests__/helpers/factories.ts
git commit -m "test(api): upgrade auth mock with vi.hoisted pattern, fix factories"
```

---

### Task 3: Deactivation + Session Cleanup Tests (6 tests)

**Files:**
- Create: `api/src/__tests__/integration/deactivation.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
import { User } from '../../database/entities/User';
import {
  createTestTenant,
  createTestUser,
  createTestAgent,
  createTestSession,
  createTestHandoffRequest,
} from '../helpers/factories';

describe('Deactivation + Session Cleanup', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'super_admin' });
  });

  it('should release active sessions when user is deactivated', async () => {
    const targetUser = await createTestUser(tenantId);
    const agent = await createTestAgent(tenantId, targetUser.id);
    await createTestSession(tenantId, { assignedAgentId: agent.id, status: 'active' });
    await createTestSession(tenantId, { assignedAgentId: agent.id, status: 'handoff' });

    const res = await request(app)
      .post(`/api/v1/admin/users/${targetUser.id}/deactivate`);
    expect(res.status).toBe(200);

    const sessions = await AppDataSource.getRepository(ChatSession)
      .createQueryBuilder('s')
      .where('s.tenantId = :tenantId', { tenantId })
      .getMany();
    expect(sessions).toHaveLength(2);
    sessions.forEach(s => {
      expect(s.status).toBe('waiting');
      expect(s.assignedAgentId).toBeNull();
    });
  });

  it('should reset accepted handoff requests when user is deactivated', async () => {
    const targetUser = await createTestUser(tenantId);
    const agent = await createTestAgent(tenantId, targetUser.id);
    const session = await createTestSession(tenantId);
    await createTestHandoffRequest(session.id, tenantId, {
      assignedAgentId: agent.id,
      status: 'accepted',
      acceptedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/v1/admin/users/${targetUser.id}/deactivate`);
    expect(res.status).toBe(200);

    const handoffs = await AppDataSource.getRepository(HandoffRequest).find({ where: { tenantId } });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].status).toBe('requested');
    expect(handoffs[0].assignedAgentId).toBeNull();
  });

  it('should succeed when user has no agent record', async () => {
    const targetUser = await createTestUser(tenantId, { role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/admin/users/${targetUser.id}/deactivate`);
    expect(res.status).toBe(200);

    const user = await AppDataSource.getRepository(User).findOneBy({ id: targetUser.id });
    expect(user!.isActive).toBe(false);
  });

  it('should return 400 when user is already inactive', async () => {
    const targetUser = await createTestUser(tenantId, { isActive: false });

    const res = await request(app)
      .post(`/api/v1/admin/users/${targetUser.id}/deactivate`);
    expect(res.status).toBe(400);
  });

  it('should return 400 when trying to deactivate yourself', async () => {
    const self = await createTestUser(tenantId);
    configureMockAuth(auth, { userId: self.id, tenantId, role: 'super_admin' });

    const res = await request(app)
      .post(`/api/v1/admin/users/${self.id}/deactivate`);
    expect(res.status).toBe(400);
  });

  it('should return 400 when deactivating last active admin (tenant-level)', async () => {
    const t = await createTestTenant();
    const soleAdmin = await createTestUser(t.id, { role: 'admin' });
    const caller = await createTestUser(t.id, { role: 'agent' });
    // requireAdmin allows admin + super_admin, so set role to admin
    configureMockAuth(auth, { userId: caller.id, tenantId: t.id, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/tenants/me/users/${soleAdmin.id}/deactivate`);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd api && npx vitest run src/__tests__/integration/deactivation.test.ts 2>&1`
Expected: All 6 tests pass. If any mock issues, check that `createAuthMocks()` is called before the `app` import.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/deactivation.test.ts
git commit -m "test(api): add deactivation + session cleanup integration tests"
```

---

### Task 4: Super-Admin Invite Resend/Cancel Tests (4 tests)

**Files:**
- Modify: `api/src/__tests__/integration/admin.test.ts`

- [ ] **Step 1: Rewrite admin.test.ts**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { PendingInvite } from '../../database/entities/PendingInvite';
import { createTestTenant, createTestUser, createTestPendingInvite } from '../helpers/factories';

describe('Admin Routes — Invite Management', () => {
  let tenantId: string;

  beforeEach(async () => {
    // Tenant needs clerkOrgId for the resend endpoint
    const tenant = await createTestTenant({ clerkOrgId: 'org_test123' });
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'super_admin' });
  });

  it('should resend an invite and update expiresAt', async () => {
    const invite = await createTestPendingInvite(tenantId, {
      expiresAt: new Date(Date.now() - 86400000),
    });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${tenantId}/pending-invites/${invite.id}/resend`);

    expect(res.status).toBe(200);
    const body = res.body.data || res.body;
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('should return 404 when resending non-existent invite', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000099';
    const res = await request(app)
      .post(`/api/v1/admin/tenants/${tenantId}/pending-invites/${fakeId}/resend`);
    expect(res.status).toBe(404);
  });

  it('should cancel an invite and return 204', async () => {
    const invite = await createTestPendingInvite(tenantId);

    const res = await request(app)
      .delete(`/api/v1/admin/tenants/${tenantId}/pending-invites/${invite.id}`);
    expect(res.status).toBe(204);

    const found = await AppDataSource.getRepository(PendingInvite).findOneBy({ id: invite.id });
    expect(found).toBeNull();
  });

  it('should return 404 when cancelling non-existent invite', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000099';
    const res = await request(app)
      .delete(`/api/v1/admin/tenants/${tenantId}/pending-invites/${fakeId}`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run and commit**

Run: `cd api && npx vitest run src/__tests__/integration/admin.test.ts 2>&1`

```bash
git add api/src/__tests__/integration/admin.test.ts
git commit -m "test(api): add invite resend/cancel integration tests"
```

---

### Task 5: Audit Log Fix Tests (4 tests)

**Files:**
- Create: `api/src/__tests__/integration/audit.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

import request from 'supertest';
import { app } from '../../server';
import { createTestTenant, createTestUser, createTestAuditLog } from '../helpers/factories';

describe('Audit Log API', () => {
  let tenantId: string;
  let tenantName: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ name: 'Audit Test Corp' });
    tenantId = tenant.id;
    tenantName = tenant.name;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'super_admin' });
  });

  it('should include tenantName in audit log response', async () => {
    await createTestAuditLog({ tenantId, action: 'test.action' });

    const res = await request(app).get('/api/v1/admin/audit-logs');

    expect(res.status).toBe(200);
    const logs = res.body.data;
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const log = logs.find((l: any) => l.tenantId === tenantId);
    expect(log).toBeDefined();
    expect(log.tenantName).toBe(tenantName);
  });

  it('should include events from the full end day when using to filter', async () => {
    await createTestAuditLog({
      tenantId,
      action: 'test.endofday',
      createdAt: new Date('2026-03-27T15:00:00Z'),
    });

    const res = await request(app).get('/api/v1/admin/audit-logs?to=2026-03-27');

    expect(res.status).toBe(200);
    const found = res.body.data.find((l: any) => l.action === 'test.endofday');
    expect(found).toBeDefined();
  });

  it('should include tenant_name in CSV export', async () => {
    await createTestAuditLog({ tenantId, action: 'test.csv' });

    const res = await request(app).get('/api/v1/admin/audit-logs/export');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.split('\n');
    expect(lines[0]).toContain('tenant_name');
    const dataRow = lines.find((l: string) => l.includes('test.csv'));
    expect(dataRow).toContain(tenantName);
  });

  it('should return correct pagination meta', async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        createTestAuditLog({ tenantId, action: `test.page.${i}` }),
      ),
    );

    const res = await request(app).get('/api/v1/admin/audit-logs?page=1&limit=10');

    expect(res.status).toBe(200);
    // sendSuccess wraps as { success, data, meta: { pagination } }
    const meta = res.body.meta?.pagination;
    expect(meta).toBeDefined();
    expect(meta.total).toBe(30);
    expect(meta.totalPages).toBe(3);
    expect(res.body.data).toHaveLength(10);
  });
});
```

- [ ] **Step 2: Run and commit**

Run: `cd api && npx vitest run src/__tests__/integration/audit.test.ts 2>&1`

```bash
git add api/src/__tests__/integration/audit.test.ts
git commit -m "test(api): add audit log integration tests"
```

---

### Task 6: Chat Lifecycle Tests (4 tests)

**Files:**
- Modify: `api/src/__tests__/integration/chat.test.ts`

Note: Chat history and close routes use `authenticateWidget` middleware (defined first in Express router). Tests must obtain a widget session token via `POST /auth/widget`, then use it for subsequent requests.

- [ ] **Step 1: Rewrite chat.test.ts**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { createTestTenant, createTestUser } from '../helpers/factories';

describe('Chat Routes', () => {
  describe('Widget Auth', () => {
    it('should create a session via widget auth with valid API key', async () => {
      const tenant = await createTestTenant();

      const res = await request(app)
        .post('/api/v1/auth/widget')
        .send({ apiKey: tenant.apiKey });

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      expect(data.token || data.sessionId).toBeDefined();
    });
  });

  describe('Chat Operations (via widget auth)', () => {
    let tenant: any;
    let widgetToken: string;
    let sessionId: string;

    beforeEach(async () => {
      tenant = await createTestTenant();
      // Get widget token
      const authRes = await request(app)
        .post('/api/v1/auth/widget')
        .send({ apiKey: tenant.apiKey });
      const authData = authRes.body.data || authRes.body;
      widgetToken = authData.token;
      sessionId = authData.sessionId || authData.session?.id;
    });

    it('should send a message and retrieve it in history', async () => {
      // Send a message
      const sendRes = await request(app)
        .post(`/api/v1/chats/${sessionId}/message`)
        .set('Authorization', `Bearer ${widgetToken}`)
        .send({ content: 'Hello from test', type: 'text' });

      expect(sendRes.status).toBe(200);

      // Get history — messages may be encrypted in DB but API returns decrypted
      const historyRes = await request(app)
        .get(`/api/v1/chats/${sessionId}/history`)
        .set('Authorization', `Bearer ${widgetToken}`);

      expect(historyRes.status).toBe(200);
      const data = historyRes.body.data || historyRes.body;
      const messages = data.messages || data;
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('should close a session', async () => {
      const res = await request(app)
        .post(`/api/v1/chats/${sessionId}/close`)
        .set('Authorization', `Bearer ${widgetToken}`);

      expect(res.status).toBe(200);

      const updated = await AppDataSource.getRepository(ChatSession).findOneBy({ id: sessionId });
      expect(updated!.status).toBe('closed');
    });

    it('should get chat history with pagination', async () => {
      // Send multiple messages
      for (let i = 0; i < 15; i++) {
        await request(app)
          .post(`/api/v1/chats/${sessionId}/message`)
          .set('Authorization', `Bearer ${widgetToken}`)
          .send({ content: `Message ${i}`, type: 'text' });
      }

      const res = await request(app)
        .get(`/api/v1/chats/${sessionId}/history?limit=10`)
        .set('Authorization', `Bearer ${widgetToken}`);

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      const messages = data.messages || data;
      expect(Array.isArray(messages) ? messages.length : 0).toBeLessThanOrEqual(10);
    });
  });
});
```

- [ ] **Step 2: Run and commit**

Run: `cd api && npx vitest run src/__tests__/integration/chat.test.ts 2>&1`
Expected: Tests pass. Widget auth flow creates a session + returns a token. If the response shape differs, adjust `widgetToken` and `sessionId` extraction.

```bash
git add api/src/__tests__/integration/chat.test.ts
git commit -m "test(api): add chat lifecycle integration tests via widget auth"
```

---

### Task 7: Handoff Flow Tests (4 tests)

**Files:**
- Modify: `api/src/__tests__/integration/handoff.test.ts`

Uses the DB-backed handoff endpoints: `POST /handoffs/:id/accept`, `POST /handoffs/:id/decline`, `GET /handoffs/queue`.

- [ ] **Step 1: Rewrite handoff.test.ts**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
import {
  createTestTenant,
  createTestUser,
  createTestAgent,
  createTestSession,
  createTestHandoffRequest,
} from '../helpers/factories';

describe('Handoff Routes (DB-backed)', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'super_admin' });
  });

  it('should accept a handoff request', async () => {
    const user = await createTestUser(tenantId);
    const agent = await createTestAgent(tenantId, user.id, { status: 'online' });
    const session = await createTestSession(tenantId, { status: 'waiting' });
    const handoff = await createTestHandoffRequest(session.id, tenantId);

    configureMockAuth(auth, { userId: user.id, tenantId, agentId: agent.id, role: 'admin' });

    const res = await request(app).post(`/api/v1/handoffs/${handoff.id}/accept`);
    expect(res.status).toBe(200);

    const updated = await AppDataSource.getRepository(HandoffRequest).findOneBy({ id: handoff.id });
    expect(updated!.status).toBe('accepted');
    expect(updated!.assignedAgentId).toBe(agent.id);
  });

  it('should decline a handoff request', async () => {
    const session = await createTestSession(tenantId, { status: 'waiting' });
    const handoff = await createTestHandoffRequest(session.id, tenantId);

    const res = await request(app).post(`/api/v1/handoffs/${handoff.id}/decline`);
    expect(res.status).toBe(200);

    const updated = await AppDataSource.getRepository(HandoffRequest).findOneBy({ id: handoff.id });
    expect(updated!.status).toBe('rejected');
  });

  it('should return only pending requests in queue', async () => {
    const s1 = await createTestSession(tenantId);
    const s2 = await createTestSession(tenantId);
    const s3 = await createTestSession(tenantId);
    await createTestHandoffRequest(s1.id, tenantId, { status: 'requested' });
    await createTestHandoffRequest(s2.id, tenantId, { status: 'requested' });
    await createTestHandoffRequest(s3.id, tenantId, { status: 'accepted' });

    const res = await request(app).get('/api/v1/handoffs/queue');
    expect(res.status).toBe(200);

    // Response shape: { success, data: { queue: [...] } } or similar
    const data = res.body.data || res.body;
    const items = data.queue || data.requests || (Array.isArray(data) ? data : []);
    expect(items.length).toBe(2);
  });

  it('should return 404 for non-existent handoff', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000099';
    const res = await request(app).post(`/api/v1/handoffs/${fakeId}/accept`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run and commit**

Run: `cd api && npx vitest run src/__tests__/integration/handoff.test.ts 2>&1`

```bash
git add api/src/__tests__/integration/handoff.test.ts
git commit -m "test(api): add handoff flow integration tests"
```

---

### Task 8: Agent Management Tests (3 tests)

**Files:**
- Modify: `api/src/__tests__/integration/agents.test.ts`

- [ ] **Step 1: Rewrite agents.test.ts**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

import request from 'supertest';
import { app } from '../../server';
import { createTestTenant, createTestUser, createTestAgent } from '../helpers/factories';

describe('Agent Routes', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'super_admin' });
  });

  it('should list agents scoped to tenant', async () => {
    const u1 = await createTestUser(tenantId);
    const u2 = await createTestUser(tenantId);
    const u3 = await createTestUser(tenantId);
    await createTestAgent(tenantId, u1.id);
    await createTestAgent(tenantId, u2.id);
    await createTestAgent(tenantId, u3.id);

    const res = await request(app).get('/api/v1/agents');
    expect(res.status).toBe(200);

    // Response: { success, data: { agents: [...], meta } }
    const data = res.body.data || res.body;
    const agents = data.agents || (Array.isArray(data) ? data : []);
    expect(agents.length).toBeGreaterThanOrEqual(3);
  });

  it('should create an agent with default offline status', async () => {
    const user = await createTestUser(tenantId);

    const res = await request(app)
      .post('/api/v1/agents')
      .send({ userId: user.id });

    expect(res.status).toBe(201);
    // Response: { success, data: { agent: { ... } } }
    const data = res.body.data || res.body;
    const agent = data.agent || data;
    expect(agent.status).toBe('offline');
  });

  it('should update agent status', async () => {
    const user = await createTestUser(tenantId);
    const agent = await createTestAgent(tenantId, user.id, { status: 'offline' });

    const res = await request(app)
      .patch(`/api/v1/agents/${agent.id}/status`)
      .send({ status: 'online' });

    expect(res.status).toBe(200);
    const data = res.body.data || res.body;
    const updated = data.agent || data;
    expect(updated.status).toBe('online');
  });
});
```

- [ ] **Step 2: Run and commit**

Run: `cd api && npx vitest run src/__tests__/integration/agents.test.ts 2>&1`

```bash
git add api/src/__tests__/integration/agents.test.ts
git commit -m "test(api): add agent management integration tests"
```

---

### Task 9: Tenant Management + Widget Config Tests (4 tests)

**Files:**
- Modify: `api/src/__tests__/integration/tenant.test.ts`

- [ ] **Step 1: Rewrite tenant.test.ts**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

import request from 'supertest';
import { app } from '../../server';
import { createTestTenant, createTestUser } from '../helpers/factories';

describe('Tenant Routes', () => {
  describe('Self-service (/tenants/me)', () => {
    let tenantId: string;

    beforeEach(async () => {
      const tenant = await createTestTenant();
      tenantId = tenant.id;
      const user = await createTestUser(tenantId, { role: 'admin' });
      configureMockAuth(auth, { userId: user.id, tenantId, role: 'admin' });
    });

    it('should get tenant details', async () => {
      const res = await request(app).get('/api/v1/tenants/me');
      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      expect(data.id || data.name).toBeDefined();
    });

    it('should update tenant webhook URL', async () => {
      const res = await request(app)
        .patch('/api/v1/tenants/me')
        .send({ webhookUrl: 'https://example.com/webhook' });
      expect(res.status).toBe(200);
    });
  });

  describe('Admin API key rotation', () => {
    it('should rotate API key and return new raw key', async () => {
      const tenant = await createTestTenant();
      const admin = await createTestUser(tenant.id, { role: 'super_admin' });
      configureMockAuth(auth, { userId: admin.id, tenantId: tenant.id, role: 'super_admin' });
      const oldKey = tenant.apiKey;

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${tenant.id}/api-key/rotate`);

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      expect(data.apiKey).toBeDefined();
      expect(data.apiKey).not.toBe(oldKey);
    });
  });

  describe('Widget config', () => {
    it('should return widget configuration for a tenant', async () => {
      const tenant = await createTestTenant();

      const res = await request(app)
        .get(`/api/v1/widget/config/${tenant.id}`);
      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      expect(data.tenantId || data.name).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run and commit**

Run: `cd api && npx vitest run src/__tests__/integration/tenant.test.ts 2>&1`

```bash
git add api/src/__tests__/integration/tenant.test.ts
git commit -m "test(api): add tenant management and widget config tests"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Run the full test suite**

Run: `cd api && npx vitest run 2>&1`
Expected: All tests pass. Count should be ~30+ tests.

- [ ] **Step 2: Run type checks**

Run: `cd api && npx tsc --noEmit && cd ../portal && npx tsc --noEmit`

- [ ] **Step 3: Verify CI workflow location**

Run: `git rev-parse --show-toplevel` — should show the repo root (one level above `chatbot-platform/`). The workflow at `.github/workflows/test.yml` should be relative to this root. If the git root IS `chatbot-platform/`, remove the `chatbot-platform/` prefix from all `working-directory` values in the workflow.
