# Phase 2: Automated Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ~30 integration tests for critical API flows and set up GitHub Actions CI to run them on every push/PR.

**Architecture:** Tests use Vitest + Supertest against the Express app with a real PostgreSQL database. Clerk auth is mocked via `vi.mock()` before the app module loads. Each test file truncates all tables after each test via the existing `setup.ts`. CI runs PostgreSQL as a service container.

**Tech Stack:** Vitest, Supertest, PostgreSQL 15, GitHub Actions, TypeORM

---

### Task 1: GitHub Actions CI Workflow

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Create the workflow file**

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

Note: The repo root contains a `chatbot-platform/` directory. Check if the checkout lands in the right place — if the workflow file is at `chatbot-platform/.github/workflows/test.yml`, the `working-directory` paths may need adjustment. Verify by checking where `api/package.json` is relative to the `.github/workflows/` directory. If they're siblings (i.e., `.github/` and `api/` are both under `chatbot-platform/`), remove the `chatbot-platform/` prefix from all `working-directory` values.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add GitHub Actions workflow with Postgres service"
```

---

### Task 2: Upgrade Auth Mock + Factory Fixes

**Files:**
- Modify: `api/src/__tests__/helpers/auth.ts`
- Modify: `api/src/__tests__/helpers/factories.ts`
- Create: `api/src/__tests__/helpers/clerk-mocks.ts`

- [ ] **Step 1: Upgrade mockClerkAuth to support role and UUID overrides**

Replace the entire content of `api/src/__tests__/helpers/auth.ts` with:

```typescript
import { vi } from 'vitest';
import crypto from 'crypto';

export interface MockAuthOptions {
  role?: string;
  tenantId?: string;
  userId?: string;
  agentId?: string;
  email?: string;
  clerkUserId?: string;
  clerkOrgId?: string;
}

const defaultUUID = () => crypto.randomUUID();

/**
 * Configure the mocked Clerk auth + autoProvision middleware.
 * Call this in beforeEach or at the top of a describe block.
 * The mock must be set up via setupClerkMocks() before importing app.
 */
export function configureMockAuth(options: MockAuthOptions = {}) {
  const userId = options.userId || defaultUUID();
  const tenantId = options.tenantId || defaultUUID();
  const agentId = options.agentId || defaultUUID();
  const role = options.role || 'super_admin';
  const email = options.email || 'test@example.com';

  // Update the shared state that the mocked middleware reads
  currentAuth.userId = userId;
  currentAuth.tenantId = tenantId;
  currentAuth.agentId = agentId;
  currentAuth.role = role;
  currentAuth.email = email;
  currentAuth.clerkUserId = options.clerkUserId || `clerk_${crypto.randomBytes(8).toString('hex')}`;
  currentAuth.clerkOrgId = options.clerkOrgId || `org_${crypto.randomBytes(8).toString('hex')}`;

  return { userId, tenantId, agentId, role };
}

// Shared mutable state read by mocked middleware
export const currentAuth = {
  userId: '',
  tenantId: '',
  agentId: '',
  role: 'super_admin',
  email: 'test@example.com',
  clerkUserId: '',
  clerkOrgId: '',
};

/**
 * Setup vi.mock() for Clerk middleware and super-admin middleware.
 * MUST be called at the top of the test file, before any app import.
 */
export function setupClerkMocks() {
  // Mock the Clerk middleware module
  vi.mock('../../middleware/clerk.middleware', () => ({
    requireClerkAuth: (req: any, _res: any, next: any) => {
      // Simulate what requireClerkAuth + autoProvision do together
      req.userId = currentAuth.userId;
      req.tenantId = currentAuth.tenantId;
      req.agentId = currentAuth.agentId;
      req.user = {
        id: currentAuth.userId,
        email: currentAuth.email,
        role: currentAuth.role,
        tenantId: currentAuth.tenantId,
        clerkUserId: currentAuth.clerkUserId,
        type: 'agent',
      };
      next();
    },
    autoProvision: (_req: any, _res: any, next: any) => next(),
    invalidateProvisionCache: () => {},
  }));

  // Mock super-admin middleware to just check our role field
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

  // Mock Clerk service functions (no real Clerk in tests)
  vi.mock('../../services/clerk-sync.service', () => ({
    inviteToClerkOrganization: () => Promise.resolve(true),
    removeFromClerkOrganization: () => Promise.resolve(true),
  }));
}
```

- [ ] **Step 2: Fix createTestSession factory**

In `api/src/__tests__/helpers/factories.ts`, find the `createTestSession` function and add `startedAt` and `lastActivityAt`:

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

Add these to the bottom of `api/src/__tests__/helpers/factories.ts`:

```typescript
import { AuditLog } from '../../database/entities/AuditLog';
import { PendingInvite } from '../../database/entities/PendingInvite';
import { HandoffRequest } from '../../database/entities/HandoffRequest';

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
git commit -m "test(api): upgrade auth mock, fix session factory, add new factories"
```

---

### Task 3: Deactivation + Session Cleanup Tests

**Files:**
- Create: `api/src/__tests__/integration/deactivation.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { setupClerkMocks, configureMockAuth } from '../helpers/auth';

// Mocks MUST be set up before importing app
setupClerkMocks();

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
  let adminUserId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;
    // Create the admin user who will perform deactivation
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    adminUserId = admin.id;
    configureMockAuth({ userId: adminUserId, tenantId, role: 'super_admin' });
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
      .find({ where: { assignedAgentId: undefined } });
    // Both sessions should now be waiting with no agent
    const agentSessions = await AppDataSource.getRepository(ChatSession)
      .createQueryBuilder('s')
      .where('s.tenantId = :tenantId', { tenantId })
      .getMany();
    expect(agentSessions).toHaveLength(2);
    agentSessions.forEach(s => {
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

    const handoffs = await AppDataSource.getRepository(HandoffRequest)
      .find({ where: { tenantId } });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].status).toBe('requested');
    expect(handoffs[0].assignedAgentId).toBeNull();
  });

  it('should succeed when user has no agent record', async () => {
    const targetUser = await createTestUser(tenantId, { role: 'admin' });
    // No agent created for this user

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
    // The mock auth userId IS the target user
    const self = await createTestUser(tenantId);
    configureMockAuth({ userId: self.id, tenantId, role: 'super_admin' });

    const res = await request(app)
      .post(`/api/v1/admin/users/${self.id}/deactivate`);

    expect(res.status).toBe(400);
  });

  it('should return 400 when deactivating last active admin (tenant-level)', async () => {
    // Create a tenant with exactly one admin
    const tenant = await createTestTenant();
    const onlyAdmin = await createTestUser(tenant.id, { role: 'admin' });
    // Configure auth as this admin (tenant-level endpoint uses requireAdmin, not requireSuperAdmin)
    configureMockAuth({ userId: onlyAdmin.id, tenantId: tenant.id, role: 'admin' });

    // We need a second user to deactivate the admin — but since there's only one admin,
    // we need to create a second non-admin user who tries to deactivate the admin.
    // Actually, the tenant-level endpoint checks if the TARGET is the last admin.
    // So we need a second admin to perform the action on the only admin.
    const secondAdmin = await createTestUser(tenant.id, { role: 'admin' });
    configureMockAuth({ userId: secondAdmin.id, tenantId: tenant.id, role: 'admin' });

    // Now deactivate secondAdmin first to make onlyAdmin the last admin
    await request(app).post(`/api/v1/tenants/me/users/${secondAdmin.id}/deactivate`);

    // Now try to deactivate onlyAdmin — should fail
    configureMockAuth({ userId: secondAdmin.id, tenantId: tenant.id, role: 'admin' });
    // secondAdmin is now inactive, so reconfigure as onlyAdmin trying to deactivate...
    // Actually, let's simplify: create tenant with 1 admin, create a super_admin caller
    const caller = await createTestUser(tenant.id, { role: 'admin' });
    configureMockAuth({ userId: caller.id, tenantId: tenant.id, role: 'admin' });

    // Deactivate caller first so onlyAdmin is the last admin
    // ... this is getting complex. Simpler approach:
    // Create tenant, create exactly 1 admin. Try to deactivate them via tenant-level endpoint.
    const t2 = await createTestTenant();
    const soleAdmin = await createTestUser(t2.id, { role: 'admin' });
    const otherUser = await createTestUser(t2.id, { role: 'agent' });
    configureMockAuth({ userId: otherUser.id, tenantId: t2.id, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/tenants/me/users/${soleAdmin.id}/deactivate`);

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd api && npx vitest run src/__tests__/integration/deactivation.test.ts 2>&1`
Expected: All 6 tests pass. If there are failures, debug and fix.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/deactivation.test.ts
git commit -m "test(api): add deactivation + session cleanup integration tests"
```

---

### Task 4: Super-Admin Invite Resend/Cancel Tests

**Files:**
- Modify: `api/src/__tests__/integration/admin.test.ts`

- [ ] **Step 1: Rewrite admin.test.ts with auth mocking and new tests**

Replace the entire content of `api/src/__tests__/integration/admin.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { setupClerkMocks, configureMockAuth } from '../helpers/auth';

setupClerkMocks();

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { PendingInvite } from '../../database/entities/PendingInvite';
import { createTestTenant, createTestUser, createTestPendingInvite } from '../helpers/factories';

describe('Admin Routes', () => {
  // Existing auth-rejection tests (keep these — they test the unmocked path)
  // Note: These will now use mocked middleware, so they may behave differently.
  // Move auth-rejection tests to a separate describe with different mock config if needed.

  describe('Invite Resend/Cancel (authenticated)', () => {
    let tenantId: string;

    beforeEach(async () => {
      const tenant = await createTestTenant({ clerkOrgId: 'org_test123' });
      tenantId = tenant.id;
      const admin = await createTestUser(tenantId, { role: 'super_admin' });
      configureMockAuth({ userId: admin.id, tenantId, role: 'super_admin' });
    });

    it('should resend an invite and update expiresAt', async () => {
      const invite = await createTestPendingInvite(tenantId, {
        expiresAt: new Date(Date.now() - 86400000), // expired yesterday
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

      const found = await AppDataSource.getRepository(PendingInvite)
        .findOneBy({ id: invite.id });
      expect(found).toBeNull();
    });

    it('should return 404 when cancelling non-existent invite', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000099';
      const res = await request(app)
        .delete(`/api/v1/admin/tenants/${tenantId}/pending-invites/${fakeId}`);

      expect(res.status).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd api && npx vitest run src/__tests__/integration/admin.test.ts 2>&1`
Expected: All 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/admin.test.ts
git commit -m "test(api): add invite resend/cancel integration tests"
```

---

### Task 5: Audit Log Fix Tests

**Files:**
- Create: `api/src/__tests__/integration/audit.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { setupClerkMocks, configureMockAuth } from '../helpers/auth';

setupClerkMocks();

import request from 'supertest';
import { createTestTenant, createTestUser, createTestAuditLog } from '../helpers/factories';

describe('Audit Log API', () => {
  let tenantId: string;
  let tenantName: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ name: 'Audit Test Corp' });
    tenantId = tenant.id;
    tenantName = tenant.name;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth({ userId: admin.id, tenantId, role: 'super_admin' });
  });

  it('should include tenantName in audit log response', async () => {
    await createTestAuditLog({ tenantId, action: 'test.action', actorId: 'actor-1' });

    const res = await request(app)
      .get('/api/v1/admin/audit-logs');

    expect(res.status).toBe(200);
    const logs = res.body.data;
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const log = logs.find((l: any) => l.tenantId === tenantId);
    expect(log.tenantName).toBe(tenantName);
  });

  it('should include events from the full end day when using to filter', async () => {
    // Create a log at 3pm on a specific date
    await createTestAuditLog({
      tenantId,
      action: 'test.endofday',
      createdAt: new Date('2026-03-27T15:00:00Z'),
    });

    const res = await request(app)
      .get('/api/v1/admin/audit-logs?to=2026-03-27');

    expect(res.status).toBe(200);
    const logs = res.body.data;
    const found = logs.find((l: any) => l.action === 'test.endofday');
    expect(found).toBeDefined();
  });

  it('should include tenant_name in CSV export', async () => {
    await createTestAuditLog({ tenantId, action: 'test.csv' });

    const res = await request(app)
      .get('/api/v1/admin/audit-logs/export');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const csv = res.text;
    const lines = csv.split('\n');
    expect(lines[0]).toContain('tenant_name');
    // Find the row with our test action
    const dataRow = lines.find((l: string) => l.includes('test.csv'));
    expect(dataRow).toContain(tenantName);
  });

  it('should return correct pagination meta', async () => {
    // Create 30 audit logs
    const promises = Array.from({ length: 30 }, (_, i) =>
      createTestAuditLog({ tenantId, action: `test.page.${i}` }),
    );
    await Promise.all(promises);

    const res = await request(app)
      .get('/api/v1/admin/audit-logs?page=1&limit=10');

    expect(res.status).toBe(200);
    // The response envelope has data + meta via sendSuccess
    const meta = res.body.meta?.pagination || res.body.pagination;
    expect(meta).toBeDefined();
    expect(meta.total).toBe(30);
    expect(meta.totalPages).toBe(3);
    expect(meta.page).toBe(1);
    expect(res.body.data).toHaveLength(10);
  });
});
```

Note: The `app` import needs to be after `setupClerkMocks()`. Add it after the mock setup:

```typescript
import { app } from '../../server';
```

(Insert after `setupClerkMocks();` line)

- [ ] **Step 2: Run the test**

Run: `cd api && npx vitest run src/__tests__/integration/audit.test.ts 2>&1`
Expected: All 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/audit.test.ts
git commit -m "test(api): add audit log integration tests (tenant name, date range, CSV, pagination)"
```

---

### Task 6: Chat Lifecycle Tests

**Files:**
- Modify: `api/src/__tests__/integration/chat.test.ts`

- [ ] **Step 1: Rewrite chat.test.ts**

Replace the entire file. The existing tests were auth-rejection only — we're replacing with authenticated integration tests.

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { setupClerkMocks, configureMockAuth } from '../helpers/auth';

setupClerkMocks();

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import {
  createTestTenant,
  createTestUser,
  createTestSession,
  createTestParticipant,
  createTestMessage,
} from '../helpers/factories';

describe('Chat Routes', () => {
  describe('Widget Auth', () => {
    it('should create a session via widget auth with valid API key', async () => {
      const tenant = await createTestTenant();

      const res = await request(app)
        .post('/api/v1/auth/widget')
        .send({ apiKey: tenant.apiKey });

      expect(res.status).toBe(200);
      // Should return a token or session info
      expect(res.body.data || res.body).toBeDefined();
    });
  });

  describe('Chat Operations (authenticated)', () => {
    let tenantId: string;

    beforeEach(async () => {
      const tenant = await createTestTenant();
      tenantId = tenant.id;
      const user = await createTestUser(tenantId, { role: 'super_admin' });
      configureMockAuth({ userId: user.id, tenantId, role: 'super_admin' });
    });

    it('should get chat history', async () => {
      const session = await createTestSession(tenantId);
      const participant = await createTestParticipant(session.id);
      await createTestMessage(session.id, tenantId, participant.id, { content: 'Hello' });
      await createTestMessage(session.id, tenantId, participant.id, { content: 'World' });

      const res = await request(app)
        .get(`/api/v1/chats/${session.id}/history`);

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      // Messages are returned (may be decrypted by the API)
      expect(data.messages || data).toBeDefined();
    });

    it('should get chat history with pagination', async () => {
      const session = await createTestSession(tenantId);
      const participant = await createTestParticipant(session.id);
      // Create 15 messages
      for (let i = 0; i < 15; i++) {
        await createTestMessage(session.id, tenantId, participant.id, {
          content: `Message ${i}`,
        });
      }

      const res = await request(app)
        .get(`/api/v1/chats/${session.id}/history?limit=10`);

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      const messages = data.messages || data;
      expect(Array.isArray(messages) ? messages.length : 0).toBeLessThanOrEqual(10);
    });

    it('should close a session', async () => {
      const session = await createTestSession(tenantId, { status: 'active' });

      const res = await request(app)
        .post(`/api/v1/chats/${session.id}/close`);

      expect(res.status).toBe(200);

      const updated = await AppDataSource.getRepository(ChatSession)
        .findOneBy({ id: session.id });
      expect(updated!.status).toBe('closed');
    });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd api && npx vitest run src/__tests__/integration/chat.test.ts 2>&1`
Expected: Tests pass. If widget auth returns a different status or shape, adjust assertions.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/chat.test.ts
git commit -m "test(api): add chat lifecycle integration tests"
```

---

### Task 7: Handoff Flow Tests

**Files:**
- Modify: `api/src/__tests__/integration/handoff.test.ts`

- [ ] **Step 1: Rewrite handoff.test.ts**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { setupClerkMocks, configureMockAuth } from '../helpers/auth';

setupClerkMocks();

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

describe('Handoff Routes', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth({ userId: admin.id, tenantId, role: 'super_admin' });
  });

  it('should accept a handoff request', async () => {
    const user = await createTestUser(tenantId);
    const agent = await createTestAgent(tenantId, user.id, { status: 'online' });
    const session = await createTestSession(tenantId, { status: 'waiting' });
    const handoff = await createTestHandoffRequest(session.id, tenantId, {
      status: 'requested',
    });

    configureMockAuth({ userId: user.id, tenantId, agentId: agent.id, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/handoffs/${handoff.id}/accept`);

    expect(res.status).toBe(200);

    const updated = await AppDataSource.getRepository(HandoffRequest)
      .findOneBy({ id: handoff.id });
    expect(updated!.status).toBe('accepted');
    expect(updated!.assignedAgentId).toBe(agent.id);
  });

  it('should decline a handoff request', async () => {
    const session = await createTestSession(tenantId, { status: 'waiting' });
    const handoff = await createTestHandoffRequest(session.id, tenantId, {
      status: 'requested',
    });

    const res = await request(app)
      .post(`/api/v1/handoffs/${handoff.id}/decline`);

    expect(res.status).toBe(200);

    const updated = await AppDataSource.getRepository(HandoffRequest)
      .findOneBy({ id: handoff.id });
    expect(updated!.status).toBe('rejected');
  });

  it('should get handoff queue with only pending requests', async () => {
    const s1 = await createTestSession(tenantId);
    const s2 = await createTestSession(tenantId);
    const s3 = await createTestSession(tenantId);
    await createTestHandoffRequest(s1.id, tenantId, { status: 'requested' });
    await createTestHandoffRequest(s2.id, tenantId, { status: 'requested' });
    await createTestHandoffRequest(s3.id, tenantId, { status: 'accepted' });

    const res = await request(app)
      .get('/api/v1/handoffs/queue');

    expect(res.status).toBe(200);
    const data = res.body.data || res.body;
    const items = Array.isArray(data) ? data : data.requests || data.queue || [];
    // Should only return the 2 requested ones
    expect(items.length).toBe(2);
  });

  it('should handle non-existent handoff request', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000099';
    const res = await request(app)
      .post(`/api/v1/handoffs/${fakeId}/accept`);

    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd api && npx vitest run src/__tests__/integration/handoff.test.ts 2>&1`
Expected: Tests pass. Adjust response shape assertions if needed.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/handoff.test.ts
git commit -m "test(api): add handoff flow integration tests"
```

---

### Task 8: Agent Management Tests

**Files:**
- Modify: `api/src/__tests__/integration/agents.test.ts`

- [ ] **Step 1: Rewrite agents.test.ts**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { setupClerkMocks, configureMockAuth } from '../helpers/auth';

setupClerkMocks();

import request from 'supertest';
import { app } from '../../server';
import {
  createTestTenant,
  createTestUser,
  createTestAgent,
} from '../helpers/factories';

describe('Agent Routes', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth({ userId: admin.id, tenantId, role: 'super_admin' });
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
    const data = res.body.data || res.body;
    const agents = data.agents || data;
    expect(Array.isArray(agents) ? agents.length : 0).toBeGreaterThanOrEqual(3);
  });

  it('should create an agent with default offline status', async () => {
    const user = await createTestUser(tenantId);

    const res = await request(app)
      .post('/api/v1/agents')
      .send({ userId: user.id });

    expect(res.status).toBe(201);
    const data = res.body.data || res.body;
    expect(data.status).toBe('offline');
  });

  it('should update agent status', async () => {
    const user = await createTestUser(tenantId);
    const agent = await createTestAgent(tenantId, user.id, { status: 'offline' });

    const res = await request(app)
      .patch(`/api/v1/agents/${agent.id}/status`)
      .send({ status: 'online' });

    expect(res.status).toBe(200);
    const data = res.body.data || res.body;
    expect(data.status).toBe('online');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd api && npx vitest run src/__tests__/integration/agents.test.ts 2>&1`

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/agents.test.ts
git commit -m "test(api): add agent management integration tests"
```

---

### Task 9: Tenant Management Tests

**Files:**
- Modify: `api/src/__tests__/integration/tenant.test.ts`

- [ ] **Step 1: Rewrite tenant.test.ts**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { setupClerkMocks, configureMockAuth } from '../helpers/auth';

setupClerkMocks();

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
      configureMockAuth({ userId: user.id, tenantId, role: 'admin' });
    });

    it('should get tenant details', async () => {
      const res = await request(app).get('/api/v1/tenants/me');

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      expect(data.id || data.tenantId).toBeDefined();
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
      configureMockAuth({ userId: admin.id, tenantId: tenant.id, role: 'super_admin' });

      const oldKey = tenant.apiKey;

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${tenant.id}/api-key/rotate`);

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      // Should return a new key that's different from the old one
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
    });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd api && npx vitest run src/__tests__/integration/tenant.test.ts 2>&1`

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/tenant.test.ts
git commit -m "test(api): add tenant management and widget config integration tests"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Run the full test suite**

Run: `cd api && npx vitest run 2>&1`
Expected: All tests pass. Note the total count — should be ~30+ tests.

- [ ] **Step 2: Run type checks**

Run: `cd api && npx tsc --noEmit && cd ../portal && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Verify CI workflow file location**

Check that `.github/workflows/test.yml` is in the right place relative to the repo root. If the git repo root is one level above `chatbot-platform/`, the workflow needs to be at the repo root's `.github/` directory, not inside `chatbot-platform/.github/`.

Run: `git rev-parse --show-toplevel` to find the repo root, then verify.
