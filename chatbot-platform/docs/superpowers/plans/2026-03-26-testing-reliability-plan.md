# Phase 2: Testing & Reliability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automated unit and integration tests for the chatbot platform API with CI pipeline, covering all critical paths.

**Architecture:** Vitest (already installed) with supertest for HTTP assertions. Integration tests run against a Docker Postgres container. CI workflow runs tests on every PR via GitHub Actions with a Postgres service container.

**Tech Stack:** Vitest 4.x, supertest 7.x, @vitest/coverage-v8, TypeORM, Docker Postgres 15, GitHub Actions

---

## File Structure

### Backend (api/src/)

**Modify:**
- `vitest.config.ts` — add coverage config and threshold
- `package.json` — add `@vitest/coverage-v8` dev dependency, add `test:coverage` script
- `src/__tests__/setup.ts` — already exists; will keep as-is (uses `setupFiles` pattern with synchronize). **Spec deviation note:** The spec recommends switching to `globalSetup`, but the existing `setupFiles` approach works correctly because `AppDataSource.isInitialized` prevents re-initialization, and `synchronize(true)` is idempotent. The TRUNCATE-based cleanup in `afterEach` provides sufficient isolation. The spec also recommends transaction-based isolation, but TRUNCATE is kept for simplicity since the test suite is small. These are deliberate deviations to avoid breaking the existing test infrastructure.
- `src/__tests__/helpers/auth.ts` — already exists; will extend with factory helpers

**Create:**
- `docker-compose.test.yml` — test Postgres container
- `.env.test` — test environment variables
- `src/__tests__/helpers/factories.ts` — test data factories (tenant, user, agent, session)
- `src/__tests__/unit/encryption.test.ts`
- `src/__tests__/unit/audit.test.ts`
- `src/__tests__/unit/circuit-breaker.test.ts`
- `src/__tests__/unit/clerk-sync.test.ts`
- `src/__tests__/integration/health.test.ts`
- `src/__tests__/integration/handoff.test.ts`
- `src/__tests__/integration/admin.test.ts`
- `src/__tests__/integration/tenant.test.ts`
- `src/__tests__/integration/agents.test.ts`
- `src/__tests__/integration/clerk-webhook.test.ts`
- `src/__tests__/integration/file.test.ts`

**CI:**
- `.github/workflows/test.yml` — test workflow for PRs

---

## Task 1: Test Infrastructure — Dependencies & Config

**Files:**
- Modify: `api/package.json`
- Modify: `api/vitest.config.ts`
- Create: `api/docker-compose.test.yml`
- Create: `api/.env.test`

- [ ] **Step 1: Install coverage dependency**

```bash
cd chatbot-platform/api && npm install --save-dev @vitest/coverage-v8
```

- [ ] **Step 2: Add test:coverage script to package.json**

Add to the `"scripts"` section:
```json
"test:coverage": "vitest run --coverage"
```

- [ ] **Step 3: Add coverage config to vitest.config.ts**

Add a `coverage` section inside the `test` block:

```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'lcov', 'html'],
  reportsDirectory: './coverage',
  include: ['src/**/*.ts'],
  exclude: ['src/__tests__/**', 'src/database/migrations/**'],
  thresholds: {
    lines: 20,
  },
},
```

- [ ] **Step 4: Create docker-compose.test.yml**

```yaml
version: '3.8'
services:
  test-db:
    image: postgres:15
    environment:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: chatbot_test
    ports:
      - '5433:5432'
    tmpfs:
      - /var/lib/postgresql/data
```

The `tmpfs` mount makes tests faster by running Postgres in memory.

- [ ] **Step 5: Create .env.test**

```env
TEST_DATABASE_URL=postgresql://test:test@localhost:5433/chatbot_test
JWT_SECRET=test-jwt-secret-for-testing-only
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef
NODE_ENV=test
CLERK_SECRET_KEY=test_clerk_key
CLERK_WEBHOOK_SECRET=test_webhook_secret
SUPER_ADMIN_EMAILS=test@example.com
```

- [ ] **Step 6: Verify setup works**

```bash
cd chatbot-platform/api && docker compose -f docker-compose.test.yml up -d
```

Wait for container, then:
```bash
cd chatbot-platform/api && npx vitest run src/__tests__/unit/pagination.test.ts
```

Expected: existing pagination tests pass.

- [ ] **Step 7: Commit**

```bash
git add api/package.json api/package-lock.json api/vitest.config.ts api/docker-compose.test.yml api/.env.test
git commit -m "chore: add test infrastructure — coverage config, Docker Postgres, env"
```

---

## Task 2: Test Factories — Shared Helpers

**Files:**
- Create: `api/src/__tests__/helpers/factories.ts`

- [ ] **Step 1: Create factory helpers**

```typescript
import crypto from 'crypto';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { User } from '../../database/entities/User';
import { Agent } from '../../database/entities/Agent';
import { ChatSession } from '../../database/entities/ChatSession';
import { Participant } from '../../database/entities/Participant';
import { Message } from '../../database/entities/Message';

export async function createTestTenant(overrides: Partial<Tenant> = {}): Promise<Tenant> {
  const repo = AppDataSource.getRepository(Tenant);
  return repo.save(
    repo.create({
      name: 'Test Tenant',
      slug: `test-${crypto.randomBytes(4).toString('hex')}`,
      apiKey: `cb_${crypto.randomBytes(32).toString('base64url')}`,
      tier: 'pro',
      status: 'active',
      settings: {},
      ...overrides,
    }),
  );
}

export async function createTestUser(
  tenantId: string,
  overrides: Partial<User> = {},
): Promise<User> {
  const repo = AppDataSource.getRepository(User);
  return repo.save(
    repo.create({
      tenantId,
      email: `user-${crypto.randomBytes(4).toString('hex')}@test.com`,
      name: 'Test User',
      clerkUserId: `clerk_${crypto.randomBytes(8).toString('hex')}`,
      role: 'admin',
      isActive: true,
      ...overrides,
    }),
  );
}

export async function createTestAgent(
  tenantId: string,
  userId: string,
  overrides: Partial<Agent> = {},
): Promise<Agent> {
  const repo = AppDataSource.getRepository(Agent);
  return repo.save(
    repo.create({
      tenantId,
      userId,
      status: 'online',
      maxConcurrentChats: 5,
      currentChatCount: 0,
      ...overrides,
    }),
  );
}

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
      ...overrides,
    }),
  );
}

export async function createTestParticipant(
  sessionId: string,
  tenantId: string,
  overrides: Partial<Participant> = {},
): Promise<Participant> {
  const repo = AppDataSource.getRepository(Participant);
  return repo.save(
    repo.create({
      sessionId,
      tenantId,
      participantType: 'visitor',
      participantId: `visitor-${crypto.randomBytes(4).toString('hex')}`,
      name: 'Test Visitor',
      ...overrides,
    }),
  );
}

export async function createTestMessage(
  sessionId: string,
  tenantId: string,
  participantId: string,
  overrides: Partial<Message> = {},
): Promise<Message> {
  const repo = AppDataSource.getRepository(Message);
  return repo.save(
    repo.create({
      sessionId,
      tenantId,
      participantId,
      type: 'text',
      content: 'Test message',
      status: 'sent',
      ...overrides,
    }),
  );
}
```

- [ ] **Step 2: Verify factories compile**

```bash
cd chatbot-platform/api && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/helpers/factories.ts
git commit -m "test: add shared test data factories"
```

---

## Task 3: Unit Tests — Encryption

**Files:**
- Create: `api/src/__tests__/unit/encryption.test.ts`

- [ ] **Step 1: Write encryption unit tests**

```typescript
import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  hash,
  generateToken,
  generateApiKey,
  generateSessionId,
  secureCompare,
  encryptObject,
  decryptObject,
  isEncrypted,
  generateHmac,
  verifyHmac,
  DecryptionError,
} from '../../utils/encryption';

describe('Encryption Utils', () => {
  describe('encrypt / decrypt', () => {
    it('should roundtrip a string', () => {
      const plaintext = 'Hello, world!';
      const encrypted = encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it('should return empty string for empty input', () => {
      expect(encrypt('')).toBe('');
      expect(decrypt('')).toBe('');
    });

    it('should handle unicode characters', () => {
      const text = 'Bonjour le monde! 日本語テスト';
      expect(decrypt(encrypt(text))).toBe(text);
    });

    it('should produce different ciphertext each time (random IV)', () => {
      const text = 'same input';
      const a = encrypt(text);
      const b = encrypt(text);
      expect(a).not.toBe(b);
      expect(decrypt(a)).toBe(text);
      expect(decrypt(b)).toBe(text);
    });

    it('should throw DecryptionError for tampered ciphertext', () => {
      const encrypted = encrypt('secret');
      const tampered = encrypted.slice(0, -4) + 'XXXX';
      expect(() => decrypt(tampered)).toThrow(DecryptionError);
    });

    it('should include messageId in DecryptionError when provided', () => {
      try {
        decrypt('invalid-base64-data', 'msg-123');
      } catch (e) {
        expect(e).toBeInstanceOf(DecryptionError);
        expect((e as DecryptionError).messageId).toBe('msg-123');
      }
    });
  });

  describe('encryptObject / decryptObject', () => {
    it('should roundtrip a JSON object', () => {
      const obj = { name: 'test', count: 42, nested: { key: 'val' } };
      const encrypted = encryptObject(obj);
      expect(decryptObject(encrypted)).toEqual(obj);
    });
  });

  describe('hash', () => {
    it('should produce consistent SHA-256 hex', () => {
      const h1 = hash('test');
      const h2 = hash('test');
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64); // SHA-256 hex length
    });

    it('should produce different hashes for different inputs', () => {
      expect(hash('a')).not.toBe(hash('b'));
    });
  });

  describe('generateToken', () => {
    it('should return hex string of correct length', () => {
      const token = generateToken(16);
      expect(token).toHaveLength(32); // 16 bytes = 32 hex chars
    });

    it('should default to 32 bytes', () => {
      expect(generateToken()).toHaveLength(64);
    });
  });

  describe('generateApiKey', () => {
    it('should start with cb_ prefix', () => {
      expect(generateApiKey()).toMatch(/^cb_/);
    });
  });

  describe('generateSessionId', () => {
    it('should return 32-char hex string', () => {
      expect(generateSessionId()).toHaveLength(32);
    });
  });

  describe('secureCompare', () => {
    it('should return true for equal strings', () => {
      expect(secureCompare('abc', 'abc')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(secureCompare('abc', 'xyz')).toBe(false);
    });

    it('should return false for different lengths', () => {
      expect(secureCompare('short', 'longer string')).toBe(false);
    });
  });

  describe('HMAC', () => {
    it('should generate and verify HMAC', () => {
      const data = 'payload';
      const secret = 'secret-key';
      const hmac = generateHmac(data, secret);
      expect(verifyHmac(data, hmac, secret)).toBe(true);
    });

    it('should reject wrong secret', () => {
      const hmac = generateHmac('data', 'secret');
      expect(verifyHmac('data', hmac, 'wrong-secret')).toBe(false);
    });
  });

  describe('isEncrypted', () => {
    it('should return true for encrypted data', () => {
      const encrypted = encrypt('test');
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('should return false for plain text', () => {
      expect(isEncrypted('hello')).toBe(false);
    });

    it('should return false for empty/null input', () => {
      expect(isEncrypted('')).toBe(false);
      expect(isEncrypted(null as unknown as string)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd chatbot-platform/api && npx vitest run src/__tests__/unit/encryption.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/unit/encryption.test.ts
git commit -m "test: add encryption utility unit tests"
```

---

## Task 4: Unit Tests — Audit Logger

**Files:**
- Create: `api/src/__tests__/unit/audit.test.ts`

These tests hit the DB (logAudit writes to the audit_logs table), so they require the test database.

- [ ] **Step 1: Write audit unit tests**

```typescript
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { AuditLog } from '../../database/entities/AuditLog';
import { logAudit } from '../../utils/audit';
import { createTestTenant } from '../helpers/factories';

describe('logAudit', () => {
  it('should create an audit log record', async () => {
    const tenant = await createTestTenant();

    await logAudit('actor-1', 'tenant.create', 'tenant', tenant.id, tenant.id);

    const repo = AppDataSource.getRepository(AuditLog);
    const logs = await repo.find({ where: { entityId: tenant.id } });

    expect(logs).toHaveLength(1);
    expect(logs[0].actorId).toBe('actor-1');
    expect(logs[0].action).toBe('tenant.create');
    expect(logs[0].entityType).toBe('tenant');
    expect(logs[0].tenantId).toBe(tenant.id);
  });

  it('should store metadata as JSON', async () => {
    const tenant = await createTestTenant();
    const meta = { oldRole: 'agent', newRole: 'admin' };

    await logAudit('actor-2', 'user.promote', 'user', 'user-123', tenant.id, meta);

    const repo = AppDataSource.getRepository(AuditLog);
    const logs = await repo.find({ where: { actorId: 'actor-2' } });

    expect(logs).toHaveLength(1);
    expect(logs[0].metadata).toEqual(meta);
  });

  it('should work without tenantId (platform-level action)', async () => {
    await logAudit('super-admin', 'tenant.create', 'tenant', 'new-tenant-id');

    const repo = AppDataSource.getRepository(AuditLog);
    const logs = await repo.find({ where: { actorId: 'super-admin' } });

    expect(logs).toHaveLength(1);
    expect(logs[0].tenantId).toBeNull();
  });

  it('should not throw on DB errors (graceful failure)', async () => {
    // logAudit catches errors internally — passing invalid data should not throw
    await expect(logAudit('', '', '', '')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd chatbot-platform/api && npx vitest run src/__tests__/unit/audit.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/unit/audit.test.ts
git commit -m "test: add audit logger unit tests"
```

---

## Task 5: Unit Tests — Circuit Breaker

**Files:**
- Create: `api/src/__tests__/unit/circuit-breaker.test.ts`

- [ ] **Step 1: Write circuit breaker tests**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker } from '../../n8n/circuit-breaker';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 1000,
      monitoringPeriod: 60000,
      name: 'test',
    });
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      expect(breaker.getState().state).toBe('CLOSED');
      expect(breaker.isClosed()).toBe(true);
      expect(breaker.isOpen()).toBe(false);
    });
  });

  describe('CLOSED → OPEN transition', () => {
    it('should open after reaching failure threshold', () => {
      breaker.recordFailure('err1');
      breaker.recordFailure('err2');
      expect(breaker.isClosed()).toBe(true);

      breaker.recordFailure('err3');
      expect(breaker.isOpen()).toBe(true);
    });

    it('should reset failure count on success', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess();
      breaker.recordFailure();
      breaker.recordFailure();
      // Only 2 consecutive failures after the success reset
      expect(breaker.isClosed()).toBe(true);
    });
  });

  describe('OPEN → HALF_OPEN transition', () => {
    it('should transition to HALF_OPEN after timeout', () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.isOpen()).toBe(true);

      // Fast-forward past timeout
      vi.useFakeTimers();
      vi.advanceTimersByTime(1100);

      expect(breaker.getState().state).toBe('HALF_OPEN');
      vi.useRealTimers();
    });
  });

  describe('HALF_OPEN → CLOSED transition', () => {
    it('should close after reaching success threshold in HALF_OPEN', () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) breaker.recordFailure();

      // Transition to HALF_OPEN
      vi.useFakeTimers();
      vi.advanceTimersByTime(1100);
      breaker.getState(); // trigger transition check

      breaker.recordSuccess();
      expect(breaker.getState().state).toBe('HALF_OPEN');

      breaker.recordSuccess();
      expect(breaker.isClosed()).toBe(true);
      vi.useRealTimers();
    });
  });

  describe('HALF_OPEN → OPEN transition', () => {
    it('should reopen on any failure in HALF_OPEN', () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();

      vi.useFakeTimers();
      vi.advanceTimersByTime(1100);
      breaker.getState(); // trigger HALF_OPEN

      breaker.recordFailure();
      expect(breaker.isOpen()).toBe(true);
      vi.useRealTimers();
    });
  });

  describe('execute()', () => {
    it('should return result on success', async () => {
      const result = await breaker.execute(() => Promise.resolve(42));
      expect(result).toBe(42);
    });

    it('should propagate errors', async () => {
      await expect(
        breaker.execute(() => Promise.reject(new Error('fail'))),
      ).rejects.toThrow('fail');
    });

    it('should call fallback when circuit is open', async () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();

      const result = await breaker.execute(
        () => Promise.resolve('should not run'),
        () => 'fallback',
      );
      expect(result).toBe('fallback');
    });

    it('should throw when circuit is open and no fallback', async () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();

      await expect(
        breaker.execute(() => Promise.resolve('nope')),
      ).rejects.toThrow("Circuit breaker 'test' is OPEN");
    });
  });

  describe('stats', () => {
    it('should track request counts', () => {
      breaker.recordSuccess();
      breaker.recordSuccess();
      breaker.recordFailure();

      const stats = breaker.getStats();
      expect(stats.totalRequests).toBe(3);
      expect(stats.successfulRequests).toBe(2);
      expect(stats.failedRequests).toBe(1);
    });

    it('should track rejected requests', () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      breaker.recordRejection();

      expect(breaker.getStats().rejectedRequests).toBe(1);
    });
  });

  describe('reset', () => {
    it('should return to CLOSED state', () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.isOpen()).toBe(true);

      breaker.reset();
      expect(breaker.isClosed()).toBe(true);
      expect(breaker.getState().failures).toBe(0);
    });
  });

  describe('forceOpen', () => {
    it('should force the circuit open', () => {
      breaker.forceOpen();
      expect(breaker.isOpen()).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd chatbot-platform/api && npx vitest run src/__tests__/unit/circuit-breaker.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/unit/circuit-breaker.test.ts
git commit -m "test: add circuit breaker unit tests"
```

---

## Task 6: Unit Tests — Clerk Sync Service

**Files:**
- Create: `api/src/__tests__/unit/clerk-sync.test.ts`

- [ ] **Step 1: Write clerk-sync tests with mocked Clerk SDK**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Clerk SDK before importing the service
vi.mock('@clerk/express', () => ({
  clerkClient: {
    organizations: {
      createOrganization: vi.fn(),
      createOrganizationInvitation: vi.fn(),
      createOrganizationMembership: vi.fn(),
    },
  },
}));

import { clerkClient } from '@clerk/express';
import {
  createClerkOrganization,
  inviteToClerkOrganization,
  addMemberToClerkOrganization,
} from '../../services/clerk-sync.service';

const mockOrgs = vi.mocked(clerkClient.organizations);

describe('Clerk Sync Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createClerkOrganization', () => {
    it('should return org id on success', async () => {
      mockOrgs.createOrganization.mockResolvedValue({ id: 'org_123' } as any);

      const result = await createClerkOrganization('Test Org');

      expect(result).toEqual({ id: 'org_123' });
      expect(mockOrgs.createOrganization).toHaveBeenCalledWith({ name: 'Test Org' });
    });

    it('should return null on failure', async () => {
      mockOrgs.createOrganization.mockRejectedValue(new Error('API error'));

      const result = await createClerkOrganization('Fail Org');

      expect(result).toBeNull();
    });
  });

  describe('inviteToClerkOrganization', () => {
    it('should return true on success', async () => {
      mockOrgs.createOrganizationInvitation.mockResolvedValue({} as any);

      const result = await inviteToClerkOrganization('org_1', 'user@test.com');

      expect(result).toBe(true);
      expect(mockOrgs.createOrganizationInvitation).toHaveBeenCalledWith({
        organizationId: 'org_1',
        emailAddress: 'user@test.com',
        role: 'org:member',
        inviterUserId: undefined,
      });
    });

    it('should return false on failure', async () => {
      mockOrgs.createOrganizationInvitation.mockRejectedValue(new Error('fail'));

      expect(await inviteToClerkOrganization('org_1', 'user@test.com')).toBe(false);
    });
  });

  describe('addMemberToClerkOrganization', () => {
    it('should return true on success', async () => {
      mockOrgs.createOrganizationMembership.mockResolvedValue({} as any);

      const result = await addMemberToClerkOrganization('org_1', 'user_1');

      expect(result).toBe(true);
      expect(mockOrgs.createOrganizationMembership).toHaveBeenCalledWith({
        organizationId: 'org_1',
        userId: 'user_1',
        role: 'org:admin',
      });
    });

    it('should return false on failure', async () => {
      mockOrgs.createOrganizationMembership.mockRejectedValue(new Error('fail'));

      expect(await addMemberToClerkOrganization('org_1', 'user_1')).toBe(false);
    });
  });

  // Note: removeMemberFromClerkOrganization does not exist yet.
  // Add tests here when that function is implemented.
});
```

- [ ] **Step 2: Run tests**

```bash
cd chatbot-platform/api && npx vitest run src/__tests__/unit/clerk-sync.test.ts
```

Expected: all tests pass. If `removeMemberFromClerkOrganization` doesn't exist yet, check the actual exports and adjust accordingly.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/unit/clerk-sync.test.ts
git commit -m "test: add clerk sync service unit tests"
```

---

## Task 7: Integration Tests — Health & Auth (expand existing)

**Files:**
- Create: `api/src/__tests__/integration/health.test.ts`
- Modify: `api/src/__tests__/integration/auth.test.ts` (expand with happy-path tests)

- [ ] **Step 1: Write health endpoint test**

```typescript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('GET /health', () => {
  it('should return 200 with status healthy', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'healthy');
  });
});
```

- [ ] **Step 2: Expand auth.test.ts with widget auth happy path**

Add to the existing `auth.test.ts` after the current tests:

```typescript
import { createTestTenant } from '../helpers/factories';

describe('POST /api/v1/auth/widget (happy path)', () => {
  it('should return 200 with token for valid API key', async () => {
    const tenant = await createTestTenant();

    const res = await request(app)
      .post('/api/v1/auth/widget')
      .send({ apiKey: tenant.apiKey });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('sessionId');
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd chatbot-platform/api && npx vitest run src/__tests__/integration/health.test.ts src/__tests__/integration/auth.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add api/src/__tests__/integration/health.test.ts api/src/__tests__/integration/auth.test.ts
git commit -m "test: add health check and expand auth integration tests"
```

---

## Task 8: Integration Tests — Handoff Routes

**Files:**
- Create: `api/src/__tests__/integration/handoff.test.ts`

- [ ] **Step 1: Write handoff integration tests**

Test the handoff lifecycle: request → accept → reject, and edge cases like double-accept.

```typescript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Handoff Routes', () => {
  describe('POST /api/v1/handoffs/request', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/handoffs/request')
        .send({ sessionId: '00000000-0000-0000-0000-000000000000' });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/handoffs/accept', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/handoffs/accept')
        .send({ handoffId: '00000000-0000-0000-0000-000000000000' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/handoffs/pending', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/handoffs/pending');
      expect(res.status).toBe(401);
    });
  });
});
```

Note: Full authenticated handoff tests (request → accept → reject lifecycle) require the `mockClerkAuth` middleware from `helpers/auth.ts`. The implementer should extend these tests to use the auth helper for happy-path testing. The pattern used in `webhook.test.ts` (creating entities directly via TypeORM) shows how to set up the prerequisite data.

- [ ] **Step 2: Run tests**

```bash
cd chatbot-platform/api && npx vitest run src/__tests__/integration/handoff.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/handoff.test.ts
git commit -m "test: add handoff route integration tests"
```

---

## Task 9: Integration Tests — Admin Routes

**Files:**
- Create: `api/src/__tests__/integration/admin.test.ts`

- [ ] **Step 1: Write admin route tests**

Test tenant CRUD, suspend/activate, audit log listing/export.

```typescript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Admin Routes', () => {
  describe('GET /api/v1/admin/tenants', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/admin/tenants');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/admin/tenants', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/admin/tenants')
        .send({ name: 'New Tenant' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/admin/tenants/:id', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get(
        '/api/v1/admin/tenants/00000000-0000-0000-0000-000000000000',
      );
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/admin/audit-logs', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/admin/audit-logs');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/admin/audit-logs/export', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/admin/audit-logs/export');
      expect(res.status).toBe(401);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd chatbot-platform/api && npx vitest run src/__tests__/integration/admin.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/admin.test.ts
git commit -m "test: add admin route integration tests"
```

---

## Task 10: Integration Tests — Tenant Routes

**Files:**
- Create: `api/src/__tests__/integration/tenant.test.ts`

- [ ] **Step 1: Write tenant route tests**

```typescript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Tenant Routes', () => {
  describe('GET /api/v1/tenants/me', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/tenants/me');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/tenants/me', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .patch('/api/v1/tenants/me')
        .send({ name: 'Updated' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/tenants/me/invite', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/tenants/me/invite')
        .send({ email: 'new@test.com', role: 'agent' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/tenants/me/pending-invites', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/tenants/me/pending-invites');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/tenants/me/users/:userId/deactivate', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).post(
        '/api/v1/tenants/me/users/00000000-0000-0000-0000-000000000000/deactivate',
      );
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/tenants/me/users/:userId/reactivate', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).post(
        '/api/v1/tenants/me/users/00000000-0000-0000-0000-000000000000/reactivate',
      );
      expect(res.status).toBe(401);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd chatbot-platform/api && npx vitest run src/__tests__/integration/tenant.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/tenant.test.ts
git commit -m "test: add tenant route integration tests"
```

---

## Task 11: Integration Tests — Agents Routes

**Files:**
- Create: `api/src/__tests__/integration/agents.test.ts`

- [ ] **Step 1: Write agents route tests**

```typescript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Agent Routes', () => {
  describe('GET /api/v1/agents', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/agents');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/agents/:id/status', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .patch('/api/v1/agents/00000000-0000-0000-0000-000000000000/status')
        .send({ status: 'online' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/agents/:id/metrics', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get(
        '/api/v1/agents/00000000-0000-0000-0000-000000000000/metrics',
      );
      expect(res.status).toBe(401);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd chatbot-platform/api && npx vitest run src/__tests__/integration/agents.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/agents.test.ts
git commit -m "test: add agents route integration tests"
```

---

## Task 12: Integration Tests — Clerk Webhook & File Routes

**Files:**
- Create: `api/src/__tests__/integration/clerk-webhook.test.ts`
- Create: `api/src/__tests__/integration/file.test.ts`

- [ ] **Step 1: Write clerk webhook tests**

```typescript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('Clerk Webhook Routes', () => {
  describe('POST /api/v1/webhooks/clerk', () => {
    it('should reject requests without svix headers', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks/clerk')
        .send({ type: 'user.created', data: {} });

      // Without proper Svix signature headers, should fail
      expect([400, 401, 403]).toContain(res.status);
    });
  });
});
```

- [ ] **Step 2: Write file route tests**

```typescript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('File Routes', () => {
  describe('POST /api/v1/files/upload-url', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/files/upload-url')
        .send({ fileName: 'test.png', fileType: 'image/png' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/files/:id', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get(
        '/api/v1/files/00000000-0000-0000-0000-000000000000',
      );
      expect(res.status).toBe(401);
    });
  });
});
```

- [ ] **Step 3: Run both**

```bash
cd chatbot-platform/api && npx vitest run src/__tests__/integration/clerk-webhook.test.ts src/__tests__/integration/file.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add api/src/__tests__/integration/clerk-webhook.test.ts api/src/__tests__/integration/file.test.ts
git commit -m "test: add clerk webhook and file route integration tests"
```

---

## Task 13: CI Pipeline — GitHub Actions Workflow

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Create test workflow**

```yaml
name: Tests

on:
  pull_request:
    branches: [main]
    paths:
      - 'chatbot-platform/api/**'
      - '.github/workflows/test.yml'

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

      - name: Install dependencies
        run: cd chatbot-platform/api && npm ci

      - name: Run tests with coverage
        run: cd chatbot-platform/api && npx vitest run --coverage
        env:
          TEST_DATABASE_URL: postgresql://test:test@localhost:5432/chatbot_test
          DATABASE_URL: postgresql://test:test@localhost:5432/chatbot_test
          JWT_SECRET: test-jwt-secret
          ENCRYPTION_KEY: 0123456789abcdef0123456789abcdef
          NODE_ENV: test
          CLERK_SECRET_KEY: test_clerk_key
          CLERK_WEBHOOK_SECRET: test_webhook_secret
          SUPER_ADMIN_EMAILS: test@example.com

      - name: Upload coverage report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage-report
          path: chatbot-platform/api/coverage/
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add test workflow with Postgres for PRs"
```

---

## Task 14: Run Full Suite & Verify

- [ ] **Step 1: Start test database**

```bash
cd chatbot-platform/api && docker compose -f docker-compose.test.yml up -d
```

- [ ] **Step 2: Run full test suite with coverage**

```bash
cd chatbot-platform/api && npm run test:coverage
```

Expected: all tests pass, coverage report generated. Fix any failures before proceeding.

- [ ] **Step 3: Review coverage output**

Check the terminal output for coverage percentages. Verify the 40% threshold is met. If not, identify gaps and add targeted tests.

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "test: fix test issues and verify full suite passes"
```

---

## Deferred Work (follow-up tasks, not in this plan)

These items are intentionally deferred to keep this plan focused on establishing the test infrastructure and baseline coverage:

1. **Happy-path integration tests** — The integration tests in Tasks 8-12 primarily verify auth middleware (401 rejection). Follow-up work should add authenticated happy-path tests using `mockClerkAuth` + factory data to test actual business logic (e.g., create tenant → verify in DB, request handoff → accept → verify assignment).

2. **Retry service unit tests** — `n8n/retry.service.ts` requires a Redis connection (Bull queue). Testing it requires either a Redis mock or a test Redis container. Deferred to keep this plan Docker-dependency minimal (Postgres only).

3. **Coverage threshold increase** — Initial threshold is 20% (realistic for auth-guard + unit tests). Increase to 40%+ as happy-path tests are added.

4. **`startServer()` side effects** — The existing pattern of importing `{ app }` from `server.ts` triggers `startServer()` which attempts Redis, Socket.io, and n8n initialization. These fail gracefully in test mode but produce console warnings. A future refactor could gate `startServer()` behind `if (require.main === module)` and export a `createApp()` factory instead.
