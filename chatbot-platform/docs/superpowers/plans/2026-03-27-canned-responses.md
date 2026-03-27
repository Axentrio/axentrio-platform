# Canned Responses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pre-written message templates that agents can quickly insert during live chat via slash commands or a searchable picker.

**Architecture:** Standalone CRUD module (entity, routes, schema, queries) following existing codebase patterns. Chat input component enhanced with slash-command detection and a canned-response picker popover. Variable substitution resolves `{{placeholders}}` at insert time using agent/session context.

**Tech Stack:** TypeORM entity + migration, Express routes with Zod validation, React Query hooks, shadcn/ui components.

**Important codebase conventions:**
- `req.user.id` is the **agent ID**, not the DB user ID. Use `(req as ProvisionedRequest).userId` for the DB user ID.
- `resolveTenantContext` sets `req.tenantId` for super-admin tenant switching. Always read `(req as ProvisionedRequest).tenantId` (not `req.user.tenantId`).
- Migration column names use **quoted camelCase** (e.g. `"tenantId"`) to match TypeORM's default naming, NOT snake_case.
- `api.get/post/patch/delete` in the portal **unwrap the response envelope** — callers get the inner data directly.
- `validate(schema)` defaults to `req.body`. For query params, use `validate(schema, 'query')`.
- Portal pages use **direct imports**, not `React.lazy`. No `Suspense` wrapper exists.
- Shared canned responses can be managed by `admin`, `supervisor`, and `super_admin` roles.

---

### Task 1: Database Migration

**Files:**
- Create: `api/src/database/migrations/1775400000000-CreateCannedResponses.ts`

- [ ] **Step 1: Create the migration file**

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCannedResponses1775400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE canned_responses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        "createdByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
        title VARCHAR(100) NOT NULL,
        shortcut VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        category VARCHAR(50),
        tags VARCHAR(50)[] NOT NULL DEFAULT '{}',
        scope VARCHAR(10) NOT NULL DEFAULT 'personal' CHECK (scope IN ('shared', 'personal')),
        "usageCount" INT NOT NULL DEFAULT 0,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`CREATE INDEX idx_canned_responses_tenant_active ON canned_responses("tenantId", "isActive")`);
    await queryRunner.query(`CREATE INDEX idx_canned_responses_tenant_scope ON canned_responses("tenantId", scope)`);
    await queryRunner.query(`CREATE UNIQUE INDEX idx_canned_responses_shared_shortcut ON canned_responses("tenantId", shortcut) WHERE scope = 'shared' AND "isActive" = true`);
    await queryRunner.query(`CREATE UNIQUE INDEX idx_canned_responses_personal_shortcut ON canned_responses("createdByUserId", shortcut) WHERE scope = 'personal' AND "isActive" = true`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS canned_responses`);
  }
}
```

- [ ] **Step 2: Run migration locally**

Run: `cd chatbot-platform/api && npx typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts`
Expected: Migration runs successfully, table created.

- [ ] **Step 3: Commit**

```bash
git add api/src/database/migrations/1775400000000-CreateCannedResponses.ts
git commit -m "feat(api): add canned_responses table migration"
```

---

### Task 2: Entity & Data Source Registration

**Files:**
- Create: `api/src/database/entities/CannedResponse.ts`
- Modify: `api/src/database/data-source.ts`

- [ ] **Step 1: Create entity file**

Note: Column `name` properties use the **same quoted camelCase** as the migration (TypeORM default naming strategy).

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Tenant } from './Tenant';
import { User } from './User';

export type CannedResponseScope = 'shared' | 'personal';

@Entity('canned_responses')
@Index(['tenantId', 'isActive'])
@Index(['tenantId', 'scope'])
export class CannedResponse {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId?: string;

  @Column({ type: 'varchar', length: 100 })
  title!: string;

  @Column({ type: 'varchar', length: 20 })
  shortcut!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  category?: string;

  @Column({ type: 'varchar', length: 50, array: true, default: [] })
  tags!: string[];

  @Column({ type: 'varchar', length: 10, default: 'personal' })
  scope!: CannedResponseScope;

  @Column({ type: 'int', default: 0 })
  usageCount!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant!: Tenant;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'createdByUserId' })
  createdBy?: User;
}
```

- [ ] **Step 2: Register entity in data-source.ts**

Add import at the top of `api/src/database/data-source.ts` after the other entity imports:
```typescript
import { CannedResponse } from './entities/CannedResponse';
```

Add `CannedResponse` to the `entities` array in the DataSource config, after `KnowledgeChunk`.

- [ ] **Step 3: Commit**

```bash
git add api/src/database/entities/CannedResponse.ts api/src/database/data-source.ts
git commit -m "feat(api): add CannedResponse entity and register in data source"
```

---

### Task 3: Validation Schemas

**Files:**
- Create: `api/src/schemas/canned-response.schema.ts`
- Modify: `api/src/schemas/index.ts`

- [ ] **Step 1: Create schema file**

Includes a `listCannedResponsesSchema` for query param validation (used with `validate(schema, 'query')`).

```typescript
import { z } from 'zod';

export const createCannedResponseSchema = z.object({
  title: z.string().min(1, 'Title is required').max(100),
  shortcut: z.string().min(1, 'Shortcut is required').max(20).regex(
    /^[a-zA-Z0-9_-]+$/,
    'Shortcut can only contain letters, numbers, hyphens, and underscores'
  ),
  content: z.string().min(1, 'Content is required').max(5000),
  category: z.string().max(50).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  scope: z.enum(['shared', 'personal']).default('personal'),
});

export const updateCannedResponseSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  shortcut: z.string().min(1).max(20).regex(
    /^[a-zA-Z0-9_-]+$/,
    'Shortcut can only contain letters, numbers, hyphens, and underscores'
  ).optional(),
  content: z.string().min(1).max(5000).optional(),
  category: z.string().max(50).nullable().optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
});

export const listCannedResponsesSchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  scope: z.enum(['shared', 'personal']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const useCannedResponseSchema = z.object({
  variables: z.record(z.string()).optional(),
});
```

- [ ] **Step 2: Add export to schemas/index.ts**

Add to the bottom of `api/src/schemas/index.ts`:
```typescript
export * from './canned-response.schema';
```

- [ ] **Step 3: Commit**

```bash
git add api/src/schemas/canned-response.schema.ts api/src/schemas/index.ts
git commit -m "feat(api): add canned response validation schemas"
```

---

### Task 4: API Routes — Integration Tests

**Files:**
- Create: `api/src/__tests__/integration/canned-responses.test.ts`
- Modify: `api/src/__tests__/helpers/factories.ts`

- [ ] **Step 1: Add factory helper**

Add the `CannedResponse` import **at the top** of `api/src/__tests__/helpers/factories.ts` with the other imports:
```typescript
import { CannedResponse } from '../../database/entities/CannedResponse';
```

Add the factory function **at the bottom** of the file (after the last existing factory):

```typescript
export async function createTestCannedResponse(
  tenantId: string,
  overrides: Partial<CannedResponse> = {},
): Promise<CannedResponse> {
  const repo = AppDataSource.getRepository(CannedResponse);
  return repo.save(
    repo.create({
      tenantId,
      title: 'Test Response',
      shortcut: `test-${crypto.randomBytes(4).toString('hex')}`,
      content: 'Hello {{customer_name}}, how can I help you?',
      scope: 'shared',
      ...overrides,
    }),
  );
}
```

- [ ] **Step 2: Create integration test file**

Note: `configureMockAuth` sets `req.userId` to the value passed as `userId`. Tests use the DB user ID (from `createTestUser`).

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { app } from '../../server';
import {
  createTestTenant,
  createTestUser,
  createTestCannedResponse,
} from '../helpers/factories';

describe('Canned Responses', () => {
  let tenantId: string;
  let adminUserId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'admin' });
    adminUserId = admin.id;
    configureMockAuth(auth, { userId: adminUserId, tenantId, role: 'admin' });
  });

  describe('POST /api/v1/canned-responses', () => {
    it('should create a shared canned response as admin', async () => {
      const res = await request(app)
        .post('/api/v1/canned-responses')
        .send({
          title: 'Greeting',
          shortcut: 'greet',
          content: 'Hello {{customer_name}}, welcome!',
          category: 'General',
          scope: 'shared',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.title).toBe('Greeting');
      expect(res.body.data.shortcut).toBe('greet');
      expect(res.body.data.scope).toBe('shared');
    });

    it('should create a personal canned response as agent', async () => {
      const agent = await createTestUser(tenantId, { role: 'agent' });
      configureMockAuth(auth, { userId: agent.id, tenantId, role: 'agent' });

      const res = await request(app)
        .post('/api/v1/canned-responses')
        .send({
          title: 'My Greeting',
          shortcut: 'mygreet',
          content: 'Hey there!',
          scope: 'personal',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.scope).toBe('personal');
    });

    it('should reject agent creating shared response', async () => {
      const agent = await createTestUser(tenantId, { role: 'agent' });
      configureMockAuth(auth, { userId: agent.id, tenantId, role: 'agent' });

      const res = await request(app)
        .post('/api/v1/canned-responses')
        .send({
          title: 'Shared',
          shortcut: 'shared',
          content: 'content',
          scope: 'shared',
        });

      expect(res.status).toBe(403);
    });

    it('should reject duplicate shortcut for shared responses', async () => {
      await createTestCannedResponse(tenantId, {
        scope: 'shared',
        shortcut: 'duplicate',
      });

      const res = await request(app)
        .post('/api/v1/canned-responses')
        .send({
          title: 'Another',
          shortcut: 'duplicate',
          content: 'content',
          scope: 'shared',
        });

      expect(res.status).toBe(409);
    });
  });

  describe('GET /api/v1/canned-responses', () => {
    it('should list shared + own personal responses', async () => {
      // Create admin's personal response
      await createTestCannedResponse(tenantId, {
        scope: 'personal',
        createdByUserId: adminUserId,
        shortcut: 'mypersonal',
      });

      // Create shared response
      await createTestCannedResponse(tenantId, {
        scope: 'shared',
        createdByUserId: adminUserId,
        shortcut: 'shared1',
      });

      // Create another user's personal response
      const agent = await createTestUser(tenantId, { role: 'agent' });
      await createTestCannedResponse(tenantId, {
        scope: 'personal',
        createdByUserId: agent.id,
        shortcut: 'otherpersonal',
      });

      const res = await request(app).get('/api/v1/canned-responses');

      expect(res.status).toBe(200);
      const shortcuts = res.body.data.data.map((r: any) => r.shortcut);
      expect(shortcuts).toContain('shared1');
      expect(shortcuts).toContain('mypersonal');
      expect(shortcuts).not.toContain('otherpersonal');
    });

    it('should filter by category', async () => {
      await createTestCannedResponse(tenantId, {
        category: 'Billing',
        scope: 'shared',
        shortcut: 'billing1',
      });
      await createTestCannedResponse(tenantId, {
        category: 'Support',
        scope: 'shared',
        shortcut: 'support1',
      });

      const res = await request(app).get('/api/v1/canned-responses?category=Billing');

      expect(res.status).toBe(200);
      expect(res.body.data.data.every((r: any) => r.category === 'Billing')).toBe(true);
    });

    it('should not return soft-deleted responses', async () => {
      await createTestCannedResponse(tenantId, {
        scope: 'shared',
        shortcut: 'deleted1',
        isActive: false,
      });

      const res = await request(app).get('/api/v1/canned-responses');

      expect(res.status).toBe(200);
      const shortcuts = res.body.data.data.map((r: any) => r.shortcut);
      expect(shortcuts).not.toContain('deleted1');
    });
  });

  describe('GET /api/v1/canned-responses/:id', () => {
    it('should return a single canned response', async () => {
      const cr = await createTestCannedResponse(tenantId, {
        scope: 'shared',
        shortcut: 'detail1',
      });

      const res = await request(app).get(`/api/v1/canned-responses/${cr.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.shortcut).toBe('detail1');
    });

    it('should not return another users personal response', async () => {
      const agent = await createTestUser(tenantId, { role: 'agent' });
      const cr = await createTestCannedResponse(tenantId, {
        scope: 'personal',
        createdByUserId: agent.id,
      });

      const res = await request(app).get(`/api/v1/canned-responses/${cr.id}`);

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/canned-responses/:id', () => {
    it('should update a shared response as admin', async () => {
      const cr = await createTestCannedResponse(tenantId, {
        scope: 'shared',
        createdByUserId: adminUserId,
      });

      const res = await request(app)
        .patch(`/api/v1/canned-responses/${cr.id}`)
        .send({ title: 'Updated Title' });

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Updated Title');
    });

    it('should reject agent editing shared response', async () => {
      const cr = await createTestCannedResponse(tenantId, { scope: 'shared' });
      const agent = await createTestUser(tenantId, { role: 'agent' });
      configureMockAuth(auth, { userId: agent.id, tenantId, role: 'agent' });

      const res = await request(app)
        .patch(`/api/v1/canned-responses/${cr.id}`)
        .send({ title: 'Hacked' });

      expect(res.status).toBe(403);
    });

    it('should reject agent editing another agents personal response', async () => {
      const otherAgent = await createTestUser(tenantId, { role: 'agent' });
      const cr = await createTestCannedResponse(tenantId, {
        scope: 'personal',
        createdByUserId: otherAgent.id,
      });

      const agent = await createTestUser(tenantId, { role: 'agent' });
      configureMockAuth(auth, { userId: agent.id, tenantId, role: 'agent' });

      const res = await request(app)
        .patch(`/api/v1/canned-responses/${cr.id}`)
        .send({ title: 'Stolen' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/canned-responses/:id', () => {
    it('should soft-delete a response', async () => {
      const cr = await createTestCannedResponse(tenantId, {
        scope: 'shared',
        createdByUserId: adminUserId,
      });

      const res = await request(app).delete(`/api/v1/canned-responses/${cr.id}`);

      expect(res.status).toBe(204);

      // Verify it's gone from listing
      const listRes = await request(app).get('/api/v1/canned-responses');
      const ids = listRes.body.data.data.map((r: any) => r.id);
      expect(ids).not.toContain(cr.id);
    });
  });

  describe('POST /api/v1/canned-responses/:id/use', () => {
    it('should resolve variables and increment usage count', async () => {
      const cr = await createTestCannedResponse(tenantId, {
        content: 'Hello {{customer_name}}, I am {{agent_name}}',
        scope: 'shared',
        createdByUserId: adminUserId,
      });

      const res = await request(app)
        .post(`/api/v1/canned-responses/${cr.id}/use`)
        .send({
          variables: { customer_name: 'John', agent_name: 'Sarah' },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.content).toBe('Hello John, I am Sarah');
      expect(res.body.data.usageCount).toBe(1);
    });

    it('should keep unresolved variables as placeholders', async () => {
      const cr = await createTestCannedResponse(tenantId, {
        content: 'Hello {{customer_name}}, order {{order_id}}',
        scope: 'shared',
        createdByUserId: adminUserId,
      });

      const res = await request(app)
        .post(`/api/v1/canned-responses/${cr.id}/use`)
        .send({ variables: { customer_name: 'John' } });

      expect(res.status).toBe(200);
      expect(res.body.data.content).toBe('Hello John, order {{order_id}}');
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/integration/canned-responses.test.ts`
Expected: FAIL — routes don't exist yet.

- [ ] **Step 4: Commit**

```bash
git add api/src/__tests__/integration/canned-responses.test.ts api/src/__tests__/helpers/factories.ts
git commit -m "test(api): add canned responses integration tests"
```

---

### Task 5: API Routes — Implementation

**Files:**
- Create: `api/src/routes/canned-responses.routes.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Create route file**

Key conventions used:
- `(req as ProvisionedRequest).userId` for the DB user ID (not `req.user.id` which is the agent ID)
- `(req as ProvisionedRequest).tenantId` for the effective tenant (supports super-admin context switching)
- `validate(listCannedResponsesSchema, 'query')` for GET query param validation
- Duplicate shortcut conflicts caught and returned as 409

```typescript
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { CannedResponse } from '../database/entities/CannedResponse';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { asyncHandler, NotFoundError, ForbiddenError, ConflictError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import {
  createCannedResponseSchema,
  updateCannedResponseSchema,
  useCannedResponseSchema,
  listCannedResponsesSchema,
} from '../schemas';

const router = Router();
const cannedResponseRepository = AppDataSource.getRepository(CannedResponse);

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/**
 * GET /canned-responses
 * List shared responses + caller's personal responses
 */
router.get(
  '/',
  validate(listCannedResponsesSchema, 'query'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId;
    const userId = authReq.userId;
    const params = parsePaginationParams(req.query as Record<string, unknown>);
    const { search, category, scope } = req.query;

    const qb = cannedResponseRepository.createQueryBuilder('cr')
      .where('cr.tenantId = :tenantId', { tenantId })
      .andWhere('cr.isActive = true');

    // Scope filtering: shared responses + own personal responses
    if (scope === 'shared') {
      qb.andWhere('cr.scope = :scope', { scope: 'shared' });
    } else if (scope === 'personal') {
      qb.andWhere('cr.scope = :scope AND cr.createdByUserId = :userId', { scope: 'personal', userId });
    } else {
      qb.andWhere('(cr.scope = :shared OR (cr.scope = :personal AND cr.createdByUserId = :userId))', {
        shared: 'shared',
        personal: 'personal',
        userId,
      });
    }

    if (search) {
      qb.andWhere('(cr.title ILIKE :search OR cr.shortcut ILIKE :search)', { search: `%${search}%` });
    }
    if (category) {
      qb.andWhere('cr.category = :category', { category });
    }

    qb.orderBy('cr.usageCount', 'DESC').addOrderBy('cr.createdAt', 'DESC');

    const result = await applyPagination(qb, params);
    sendSuccess(res, result);
  })
);

/**
 * GET /canned-responses/:id
 */
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId;
    const userId = authReq.userId;

    const cr = await cannedResponseRepository.findOne({
      where: { id: req.params.id, tenantId, isActive: true },
    });

    if (!cr) throw new NotFoundError('Canned response not found');
    if (cr.scope === 'personal' && cr.createdByUserId !== userId) {
      throw new NotFoundError('Canned response not found');
    }

    sendSuccess(res, cr);
  })
);

/**
 * POST /canned-responses
 * Admins/supervisors can create shared. Anyone can create personal.
 */
router.post(
  '/',
  validate(createCannedResponseSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId;
    const userId = authReq.userId;
    const role = authReq.userRole;
    const body = req.body;

    if (body.scope === 'shared' && !['admin', 'supervisor', 'super_admin'].includes(role!)) {
      throw new ForbiddenError('Only admins can create shared canned responses');
    }

    // Check for duplicate shortcut
    const existingQb = cannedResponseRepository.createQueryBuilder('cr')
      .where('cr.tenantId = :tenantId', { tenantId })
      .andWhere('cr.shortcut = :shortcut', { shortcut: body.shortcut })
      .andWhere('cr.isActive = true');

    if (body.scope === 'shared') {
      existingQb.andWhere('cr.scope = :scope', { scope: 'shared' });
    } else {
      existingQb.andWhere('cr.scope = :scope AND cr.createdByUserId = :userId', { scope: 'personal', userId });
    }

    const existing = await existingQb.getOne();
    if (existing) {
      throw new ConflictError('A canned response with this shortcut already exists');
    }

    const cr = cannedResponseRepository.create({
      ...body,
      tenantId,
      createdByUserId: userId,
    });

    const saved = await cannedResponseRepository.save(cr);
    sendCreated(res, saved);
  })
);

/**
 * PATCH /canned-responses/:id
 * Admins/supervisors can edit shared. Owners can edit their personal.
 */
router.patch(
  '/:id',
  validate(updateCannedResponseSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId;
    const userId = authReq.userId;
    const role = authReq.userRole;

    const cr = await cannedResponseRepository.findOne({
      where: { id: req.params.id, tenantId, isActive: true },
    });

    if (!cr) throw new NotFoundError('Canned response not found');

    if (cr.scope === 'shared' && !['admin', 'supervisor', 'super_admin'].includes(role!)) {
      throw new ForbiddenError('Only admins can edit shared canned responses');
    }
    if (cr.scope === 'personal' && cr.createdByUserId !== userId) {
      throw new NotFoundError('Canned response not found');
    }

    Object.assign(cr, req.body);
    const updated = await cannedResponseRepository.save(cr);
    sendSuccess(res, updated);
  })
);

/**
 * DELETE /canned-responses/:id
 * Soft delete (set isActive = false)
 */
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId;
    const userId = authReq.userId;
    const role = authReq.userRole;

    const cr = await cannedResponseRepository.findOne({
      where: { id: req.params.id, tenantId, isActive: true },
    });

    if (!cr) throw new NotFoundError('Canned response not found');

    if (cr.scope === 'shared' && !['admin', 'supervisor', 'super_admin'].includes(role!)) {
      throw new ForbiddenError('Only admins can delete shared canned responses');
    }
    if (cr.scope === 'personal' && cr.createdByUserId !== userId) {
      throw new NotFoundError('Canned response not found');
    }

    cr.isActive = false;
    await cannedResponseRepository.save(cr);
    sendNoContent(res);
  })
);

/**
 * POST /canned-responses/:id/use
 * Resolve variables, increment usage count, return resolved content
 */
router.post(
  '/:id/use',
  validate(useCannedResponseSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId;
    const userId = authReq.userId;
    const { variables = {} } = req.body;

    const cr = await cannedResponseRepository.findOne({
      where: { id: req.params.id, tenantId, isActive: true },
    });

    if (!cr) throw new NotFoundError('Canned response not found');
    if (cr.scope === 'personal' && cr.createdByUserId !== userId) {
      throw new NotFoundError('Canned response not found');
    }

    // Resolve variables — unmatched placeholders stay as-is
    const resolvedContent = cr.content.replace(
      /\{\{(\w+)\}\}/g,
      (match, key) => variables[key] ?? match
    );

    // Increment usage count
    cr.usageCount += 1;
    await cannedResponseRepository.save(cr);

    sendSuccess(res, { content: resolvedContent, usageCount: cr.usageCount });
  })
);

export default router;
```

- [ ] **Step 2: Register route in server.ts**

Add import at the top of `api/src/server.ts` after the other route imports (after line 39):
```typescript
import cannedResponseRoutes from './routes/canned-responses.routes';
```

Add to the apiRouter section (after line 143, after `knowledgeRoutes`):
```typescript
apiRouter.use('/canned-responses', cannedResponseRoutes);
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/integration/canned-responses.test.ts`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/canned-responses.routes.ts api/src/server.ts
git commit -m "feat(api): implement canned responses CRUD + use endpoint"
```

---

### Task 6: Portal — Query Keys & Hooks

**Files:**
- Modify: `portal/src/queries/queryKeys.ts`
- Create: `portal/src/queries/useCannedResponseQueries.ts`

- [ ] **Step 1: Add query keys**

Add to `portal/src/queries/queryKeys.ts` inside the `queryKeys` object, after the `knowledge` block:

```typescript
  cannedResponses: {
    all: () => ['cannedResponses'] as const,
    lists: () => [...queryKeys.cannedResponses.all(), 'list'] as const,
    list: (filters?: Record<string, unknown>) => [...queryKeys.cannedResponses.lists(), filters] as const,
    detail: (id: string) => [...queryKeys.cannedResponses.all(), 'detail', id] as const,
  },
```

- [ ] **Step 2: Create query hooks file**

Note: `api.get/post/patch/delete` unwrap the response envelope. For list endpoints returning `sendSuccess(res, result)` where result is `{data, meta}`, callers receive `{data, meta}`. For single-object responses, callers get the object directly.

```typescript
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export interface CannedResponse {
  id: string;
  tenantId: string;
  createdByUserId?: string;
  title: string;
  shortcut: string;
  content: string;
  category?: string;
  tags: string[];
  scope: 'shared' | 'personal';
  usageCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CreateCannedResponseInput {
  title: string;
  shortcut: string;
  content: string;
  category?: string;
  tags?: string[];
  scope: 'shared' | 'personal';
}

interface UpdateCannedResponseInput {
  title?: string;
  shortcut?: string;
  content?: string;
  category?: string | null;
  tags?: string[];
}

interface UseCannedResponseResult {
  content: string;
  usageCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const cannedResponseOptions = {
  list: (filters?: Record<string, unknown>) => queryOptions({
    queryKey: queryKeys.cannedResponses.list(filters),
    queryFn: () => api.get<Any>('/canned-responses', { params: filters }),
  }),
  detail: (id: string) => queryOptions({
    queryKey: queryKeys.cannedResponses.detail(id),
    queryFn: () => api.get<CannedResponse>(`/canned-responses/${id}`),
    enabled: !!id,
  }),
};

export function useCannedResponses(filters?: Record<string, unknown>) {
  return useQuery(cannedResponseOptions.list(filters));
}

export function useCannedResponseDetail(id: string) {
  return useQuery(cannedResponseOptions.detail(id));
}

export function useCreateCannedResponse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCannedResponseInput) =>
      api.post('/canned-responses', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cannedResponses.all() });
    },
  });
}

export function useUpdateCannedResponse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateCannedResponseInput) =>
      api.patch(`/canned-responses/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cannedResponses.all() });
    },
  });
}

export function useDeleteCannedResponse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/canned-responses/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cannedResponses.all() });
    },
  });
}

export function useUseCannedResponse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, variables }: { id: string; variables?: Record<string, string> }) =>
      api.post<UseCannedResponseResult>(`/canned-responses/${id}/use`, { variables }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cannedResponses.all() });
    },
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add portal/src/queries/queryKeys.ts portal/src/queries/useCannedResponseQueries.ts
git commit -m "feat(portal): add canned response query keys and hooks"
```

---

### Task 7: Portal — Management Page

**Files:**
- Create: `portal/src/pages/CannedResponses.tsx`
- Modify: `portal/src/components/Sidebar.tsx`
- Modify: `portal/src/App.tsx`

- [ ] **Step 1: Create the CannedResponses page component**

Note: Uses `PageSkeleton` from `@/components/ui/page-skeleton` and `InlineError` from `@/components/ui/inline-error` (both exist in this codebase). Uses direct import in App.tsx (no React.lazy).

```typescript
import React, { useState, useMemo } from 'react';
import { Plus, Search, Pencil, Trash2 } from 'lucide-react';
import { useAppAuth } from '@auth/useAppAuth';
import {
  useCannedResponses,
  useCreateCannedResponse,
  useUpdateCannedResponse,
  useDeleteCannedResponse,
} from '../queries/useCannedResponseQueries';
import type { CannedResponse } from '../queries/useCannedResponseQueries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { toast } from 'sonner';

interface FormData {
  title: string;
  shortcut: string;
  content: string;
  category: string;
  tags: string;
  scope: 'shared' | 'personal';
}

const emptyForm: FormData = {
  title: '',
  shortcut: '',
  content: '',
  category: '',
  tags: '',
  scope: 'personal',
};

const CannedResponses: React.FC = () => {
  const { user } = useAppAuth();
  const isAdmin = user && ['admin', 'supervisor', 'super_admin'].includes(user.role);

  const { data, isLoading, error } = useCannedResponses();
  const createMutation = useCreateCannedResponse();
  const updateMutation = useUpdateCannedResponse();
  const deleteMutation = useDeleteCannedResponse();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [scopeFilter, setScopeFilter] = useState('all');
  const [form, setForm] = useState<FormData>(emptyForm);

  const responses: CannedResponse[] = data?.data ?? [];

  const categories = useMemo(() => {
    const cats = new Set(responses.map((r) => r.category).filter(Boolean));
    return Array.from(cats) as string[];
  }, [responses]);

  const filtered = useMemo(() => {
    let result = responses;
    if (categoryFilter !== 'all') {
      result = result.filter((r) => r.category === categoryFilter);
    }
    if (scopeFilter !== 'all') {
      result = result.filter((r) => r.scope === scopeFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.shortcut.toLowerCase().includes(q) ||
          r.content.toLowerCase().includes(q)
      );
    }
    return result;
  }, [responses, categoryFilter, scopeFilter, search]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setIsModalOpen(true);
  };

  const openEdit = (cr: CannedResponse) => {
    setEditingId(cr.id);
    setForm({
      title: cr.title,
      shortcut: cr.shortcut,
      content: cr.content,
      category: cr.category ?? '',
      tags: cr.tags.join(', '),
      scope: cr.scope,
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async () => {
    const payload = {
      title: form.title,
      shortcut: form.shortcut,
      content: form.content,
      category: form.category || undefined,
      tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      scope: form.scope,
    };

    try {
      if (editingId) {
        await updateMutation.mutateAsync({ id: editingId, ...payload });
        toast.success('Canned response updated');
      } else {
        await createMutation.mutateAsync(payload);
        toast.success('Canned response created');
      }
      setIsModalOpen(false);
    } catch {
      toast.error(editingId ? 'Failed to update' : 'Failed to create');
    }
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    try {
      await deleteMutation.mutateAsync(deletingId);
      toast.success('Canned response deleted');
    } catch {
      toast.error('Failed to delete');
    }
    setDeletingId(null);
  };

  if (isLoading) return <PageSkeleton variant="list" rows={6} />;
  if (error) return <InlineError message="Failed to load canned responses" />;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Canned Responses</h1>
          <p className="text-sm text-text-secondary mt-1">
            Pre-written message templates for quick replies
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-2" /> New Response
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <Input
            placeholder="Search responses..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={scopeFilter} onValueChange={setScopeFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Scope" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="shared">Shared</SelectItem>
            <SelectItem value="personal">Personal</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-edge overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Shortcut</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead className="text-right">Used</TableHead>
              <TableHead className="w-[100px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-text-muted py-8">
                  No canned responses found
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((cr) => (
                <TableRow key={cr.id}>
                  <TableCell className="font-medium">{cr.title}</TableCell>
                  <TableCell>
                    <code className="text-xs bg-surface-3 px-1.5 py-0.5 rounded">/{cr.shortcut}</code>
                  </TableCell>
                  <TableCell>{cr.category ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={cr.scope === 'shared' ? 'default' : 'secondary'}>
                      {cr.scope}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{cr.usageCount}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(cr)}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeletingId(cr.id)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create/Edit Modal */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit' : 'New'} Canned Response</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Greeting"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="shortcut">Shortcut</Label>
              <div className="flex items-center gap-2">
                <span className="text-text-muted">/</span>
                <Input
                  id="shortcut"
                  value={form.shortcut}
                  onChange={(e) => setForm({ ...form, shortcut: e.target.value })}
                  placeholder="e.g. greet"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="content">Content</Label>
              <Textarea
                id="content"
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder="Hello {{customer_name}}, how can I help?"
                rows={4}
              />
              <p className="text-xs text-text-muted">
                Use {'{{variable_name}}'} for dynamic content
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <Input
                  id="category"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="e.g. General"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="scope">Scope</Label>
                <Select
                  value={form.scope}
                  onValueChange={(v) => setForm({ ...form, scope: v as 'shared' | 'personal' })}
                  disabled={!isAdmin && form.scope === 'shared'}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {isAdmin && <SelectItem value="shared">Shared</SelectItem>}
                    <SelectItem value="personal">Personal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tags">Tags</Label>
              <Input
                id="tags"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="billing, refund, common (comma-separated)"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsModalOpen(false)}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              disabled={!form.title || !form.shortcut || !form.content}
            >
              {editingId ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete canned response?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the response from your team. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default CannedResponses;
```

- [ ] **Step 2: Add to Sidebar**

In `portal/src/components/Sidebar.tsx`:

Add `Zap` to the lucide-react import:
```typescript
Zap,
```

Add to the `menuItems` array after the Knowledge Base entry:
```typescript
  { path: '/canned-responses', label: 'Canned Responses', icon: Zap, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
```

- [ ] **Step 3: Add route to App.tsx**

Add a direct import at the top of `portal/src/App.tsx` with the other page imports:
```typescript
import CannedResponses from './pages/CannedResponses';
```

Add the route inside the protected routes section (after the `/knowledge` route):
```typescript
<Route path="/canned-responses" element={<CannedResponses />} />
```

- [ ] **Step 4: Verify the portal builds**

Run: `cd chatbot-platform/portal && npm run build`
Expected: Build succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/CannedResponses.tsx portal/src/components/Sidebar.tsx portal/src/App.tsx
git commit -m "feat(portal): add canned responses management page with CRUD"
```

---

### Task 8: Portal — Chat Input Slash Command Integration

**Files:**
- Create: `portal/src/components/CannedResponsePicker.tsx`
- Modify: `portal/src/components/ChatWindow.tsx`

- [ ] **Step 1: Create the CannedResponsePicker component**

This component handles both the slash-command dropdown and the picker button popover.

Key fixes from review:
- `api.post` returns unwrapped data, so `result.content` not `result.data.content`
- Passes `agent_name` from auth context as a built-in variable to `/use` endpoint

```typescript
import React, { useState, useEffect, useRef } from 'react';
import { Zap, Search } from 'lucide-react';
import { useAppAuth } from '@auth/useAppAuth';
import { useCannedResponses, useUseCannedResponse } from '../queries/useCannedResponseQueries';
import type { CannedResponse } from '../queries/useCannedResponseQueries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface SlashCommandDropdownProps {
  query: string;
  onSelect: (content: string) => void;
  onClose: () => void;
  visible: boolean;
}

export const SlashCommandDropdown: React.FC<SlashCommandDropdownProps> = ({
  query,
  onSelect,
  onClose,
  visible,
}) => {
  const { user } = useAppAuth();
  const { data } = useCannedResponses();
  const useMutation = useUseCannedResponse();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const responses: CannedResponse[] = data?.data ?? [];
  const filtered = responses.filter((r) =>
    r.shortcut.toLowerCase().startsWith(query.toLowerCase())
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleSelect = async (cr: CannedResponse) => {
    try {
      const result = await useMutation.mutateAsync({
        id: cr.id,
        variables: { agent_name: user?.name ?? '' },
      });
      onSelect((result as any)?.content ?? cr.content);
    } catch {
      onSelect(cr.content);
    }
  };

  // Keyboard handler — called from ChatWindow's onKeyDown to avoid conflicts
  // This is exposed via the `onKeyDown` prop pattern below

  if (!visible || filtered.length === 0) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 bg-surface-2 border border-edge rounded-lg shadow-lg max-h-[200px] overflow-y-auto z-50"
    >
      {filtered.map((cr, i) => (
        <button
          key={cr.id}
          className={cn(
            'w-full px-3 py-2 text-left text-sm flex items-center justify-between hover:bg-surface-3',
            i === selectedIndex && 'bg-surface-3'
          )}
          onMouseDown={(e) => {
            e.preventDefault();
            handleSelect(cr);
          }}
        >
          <div>
            <span className="font-medium text-text-primary">{cr.title}</span>
            <span className="text-text-muted ml-2">/{cr.shortcut}</span>
          </div>
          {cr.category && (
            <span className="text-xs text-text-muted">{cr.category}</span>
          )}
        </button>
      ))}
    </div>
  );
};

// Export keyboard handler for use in ChatWindow
export function useSlashCommandKeyboard(
  visible: boolean,
  filteredCount: number,
  selectedIndex: number,
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>,
) {
  return (e: React.KeyboardEvent): boolean => {
    if (!visible || filteredCount === 0) return false;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filteredCount - 1));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      return true; // Signal to ChatWindow to trigger selection
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      return true;
    }
    return false;
  };
}

interface CannedResponsePickerButtonProps {
  onSelect: (content: string) => void;
}

export const CannedResponsePickerButton: React.FC<CannedResponsePickerButtonProps> = ({
  onSelect,
}) => {
  const { user } = useAppAuth();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { data } = useCannedResponses();
  const useMutation = useUseCannedResponse();

  const responses: CannedResponse[] = data?.data ?? [];
  const filtered = search
    ? responses.filter(
        (r) =>
          r.title.toLowerCase().includes(search.toLowerCase()) ||
          r.shortcut.toLowerCase().includes(search.toLowerCase())
      )
    : responses;

  // Group by category
  const grouped = filtered.reduce<Record<string, CannedResponse[]>>((acc, r) => {
    const cat = r.category ?? 'Uncategorized';
    (acc[cat] ??= []).push(r);
    return acc;
  }, {});

  const handleSelect = async (cr: CannedResponse) => {
    try {
      const result = await useMutation.mutateAsync({
        id: cr.id,
        variables: { agent_name: user?.name ?? '' },
      });
      onSelect((result as any)?.content ?? cr.content);
    } catch {
      onSelect(cr.content);
    }
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl flex-shrink-0"
          title="Canned responses"
        >
          <Zap className="w-5 h-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start" side="top">
        <div className="p-2 border-b border-edge">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <Input
              placeholder="Search responses..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          {Object.keys(grouped).length === 0 ? (
            <div className="p-4 text-center text-sm text-text-muted">
              No responses found
            </div>
          ) : (
            Object.entries(grouped).map(([category, items]) => (
              <div key={category}>
                <div className="px-3 py-1.5 text-xs font-medium text-text-muted uppercase tracking-wider bg-surface-1">
                  {category}
                </div>
                {items.map((cr) => (
                  <button
                    key={cr.id}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-surface-3 flex items-center justify-between"
                    onClick={() => handleSelect(cr)}
                  >
                    <div>
                      <div className="font-medium text-text-primary">{cr.title}</div>
                      <div className="text-xs text-text-muted truncate max-w-[220px]">
                        {cr.content}
                      </div>
                    </div>
                    <code className="text-xs text-text-muted">/{cr.shortcut}</code>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
```

- [ ] **Step 2: Integrate into ChatWindow**

Modify `portal/src/components/ChatWindow.tsx`:

Add imports at the top:
```typescript
import { SlashCommandDropdown, CannedResponsePickerButton } from './CannedResponsePicker';
```

Add state for slash command detection inside the component (after `inputRef`):
```typescript
const [slashQuery, setSlashQuery] = useState('');
const [showSlashMenu, setShowSlashMenu] = useState(false);
```

Update the `handleInputChange` function to detect slash commands:
```typescript
const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
  const value = e.target.value;
  setMessageInput(value);
  sendTyping(value.length > 0);

  // Slash command detection
  const match = value.match(/^\/(\S*)$/);
  if (match) {
    setSlashQuery(match[1]);
    setShowSlashMenu(true);
  } else {
    setShowSlashMenu(false);
  }
};
```

Add a handler for when a canned response is selected:
```typescript
const handleCannedResponseSelect = (content: string) => {
  setMessageInput(content);
  setShowSlashMenu(false);
  inputRef.current?.focus();
};
```

**Update the `handleKeyPress` function** to intercept Enter/ArrowUp/ArrowDown when the slash menu is open (this prevents Enter from sending `/shortcut` as a message):
```typescript
const handleKeyPress = (e: React.KeyboardEvent) => {
  // When slash menu is open, let it handle navigation keys
  if (showSlashMenu) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setShowSlashMenu(false);
      return;
    }
    // ArrowUp/ArrowDown/Enter are handled by the slash dropdown
    if (['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
      // Don't send the message — the dropdown will handle selection
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
};
```

In the JSX, add the `SlashCommandDropdown` inside the input wrapper div (the `<div className="flex-1 relative">` that wraps the Textarea), right before the `<Textarea>`:
```tsx
<SlashCommandDropdown
  query={slashQuery}
  onSelect={handleCannedResponseSelect}
  onClose={() => setShowSlashMenu(false)}
  visible={showSlashMenu}
/>
```

Add the `CannedResponsePickerButton` next to the Paperclip button (after it, before the Textarea wrapper):
```tsx
<CannedResponsePickerButton onSelect={handleCannedResponseSelect} />
```

- [ ] **Step 3: Verify the portal builds**

Run: `cd chatbot-platform/portal && npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/CannedResponsePicker.tsx portal/src/components/ChatWindow.tsx
git commit -m "feat(portal): add slash command and picker integration in chat input"
```

---

### Task 9: Run All Tests & Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run API tests**

Run: `cd chatbot-platform/api && npx vitest run`
Expected: All tests pass, including the new canned-responses tests.

- [ ] **Step 2: Run portal build**

Run: `cd chatbot-platform/portal && npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Run type checks**

Run: `cd chatbot-platform/api && npx tsc --noEmit && cd ../portal && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address any issues found during verification"
```
