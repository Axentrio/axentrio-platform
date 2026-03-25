# Webhook Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the existing n8n module as a generic webhook integration system with delivery logging, portal UI, and full bidirectional message flow.

**Architecture:** The n8n module is fully built (8+ files with services, schemas, types, circuit breaker, retry queue). The main work is: (1) boot & wire it in server.ts, (2) add a delivery log entity, (3) rename n8n references to generic webhook naming, (4) enhance the portal Settings Integration tab, (5) remove stubs. No new services need to be written from scratch.

**Tech Stack:** Express.js, TypeORM, PostgreSQL, Bull/Redis, Socket.io, React 18, React Query, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-26-webhook-integration-design.md`

**Base path:** `chatbot-platform/` (all relative paths below are from this root)

---

## File Structure

### Files to Create
- `api/src/database/entities/WebhookDeliveryLog.ts` — delivery log entity
- `api/src/database/migrations/<timestamp>-CreateWebhookDeliveryLog.ts` — migration
- `api/src/routes/webhook-admin.routes.ts` — tenant-scoped webhook admin endpoints (status, deliveries, test)
- `portal/src/components/settings/IntegrationTab.tsx` — extracted Integration tab component

### Files to Modify
- `api/src/server.ts` — wire createWebhookModule + initializeForwarding at boot
- `api/src/n8n/index.ts` — rename exports (N8nModule → WebhookModule, etc.)
- `api/src/n8n/webhook.routes.ts` — remove stubs, update route paths
- `api/src/n8n/outbound.service.ts` — add delivery log writes after each attempt
- `api/src/n8n/webhook.controller.ts` — add delivery log writes for inbound requests
- `api/src/config/environment.ts` — add WEBHOOK_URL with N8N_WEBHOOK_URL fallback
- `api/src/services/message-forwarding.service.ts` — no code changes, just gets initialized at boot
- `portal/src/pages/Settings.tsx` — replace inline Integration tab with extracted component

---

## Task 1: Boot & Wire the Webhook Module

**Files:**
- Modify: `api/src/server.ts:110-150`
- Modify: `api/src/config/environment.ts:98`
- Reference: `api/src/n8n/index.ts:61-116` (N8nModuleConfig, createN8nModule)
- Reference: `api/src/services/message-forwarding.service.ts:28-35` (initializeForwarding)

- [ ] **Step 1: Add WEBHOOK_URL env var with fallback**

In `api/src/config/environment.ts`, update the N8N_WEBHOOK_URL line (~line 98) to:

```typescript
webhookUrl: process.env.WEBHOOK_URL || process.env.N8N_WEBHOOK_URL || '',
```

- [ ] **Step 2: Mount the webhook module in server.ts**

In `api/src/server.ts`, after the Redis initialization (~line 136) and before `app.use('/api/v1', apiRouter)` (~line 122), add:

```typescript
// Webhook integration (must be before express.json() for raw body signature verification)
import { createN8nModule } from './n8n';
import { initializeForwarding } from './services/message-forwarding.service';

// Raw body parser for webhook signature verification — register before json parser
app.use('/api/v1/webhooks/inbound', express.raw({ type: 'application/json' }));

// Create and mount webhook module
try {
  const webhookModule = createN8nModule({
    redisUrl: config.redis.url,
    circuitBreaker: {
      failureThreshold: 5,
      successThreshold: 3,
      timeout: 30000,
    },
    retry: {
      maxRetries: config.queue.maxAttempts || 3,
      initialDelay: config.queue.backoffDelay || 1000,
      backoffMultiplier: 2,
    },
  });

  apiRouter.use('/webhooks', webhookModule.router);

  // Wire outbound message forwarding
  initializeForwarding(webhookModule.outboundService, webhookModule.fallbackService);

  logger.info('Webhook integration module initialized');
} catch (err) {
  logger.warn('Webhook module initialization failed — webhooks disabled', { error: err });
}
```

**Important:** Read `server.ts` carefully to find the exact placement. The raw body parser MUST be registered before `express.json()`. Check if `express.json()` is already applied globally — if so, the raw body route must be registered before it.

Also read `api/src/n8n/index.ts` lines 61–116 to verify the exact `N8nModuleConfig` shape and what properties `N8nModule` exposes (outboundService, fallbackService, router).

- [ ] **Step 3: Verify the server starts**

Run: `cd chatbot-platform/api && npx ts-node-dev src/server.ts`
Expected: "Webhook integration module initialized" in logs. No crash.

- [ ] **Step 4: Commit**

```bash
git add api/src/server.ts api/src/config/environment.ts
git commit -m "feat: wire webhook module into server boot sequence"
```

---

## Task 2: Rename N8n References to Generic Webhook Naming

**Files:**
- Modify: `api/src/n8n/index.ts:61-116` (rename interfaces and factory)
- Modify: `api/src/n8n/webhook.routes.ts:22` (rename createWebhookRouter config type)
- Modify: `api/src/n8n/outbound.service.ts:44-53` (rename metric names)
- Modify: `api/src/server.ts` (update import names from Task 1)
- Modify: `portal/src/pages/Settings.tsx:213` (inbound URL display)
- Rename: `docs/n8n-integration.md` → `docs/webhook-integration.md`

- [ ] **Step 1: Rename exports in n8n/index.ts**

In `api/src/n8n/index.ts`:
- Rename `N8nModuleConfig` → `WebhookModuleConfig` (line 61)
- Rename `N8nModule` → `WebhookModule` (line 103)
- Rename `createN8nModule` → `createWebhookModule` (line 116)
- Keep the old names as deprecated re-exports for safety:

```typescript
/** @deprecated Use WebhookModuleConfig */
export type N8nModuleConfig = WebhookModuleConfig;
/** @deprecated Use createWebhookModule */
export const createN8nModule = createWebhookModule;
```

- [ ] **Step 2: Rename metric names in outbound service**

In `api/src/n8n/outbound.service.ts`, search for any metric name strings containing `n8n` and replace with `webhook`. For example:
- `n8n_webhook_success` → `webhook_delivery_success`
- `n8n_webhook_failure` → `webhook_delivery_failure`

- [ ] **Step 3: Update portal inbound URL display**

In `portal/src/pages/Settings.tsx` (~line 213), change:
```typescript
const inboundWebhookUrl = `${API_URL}/v1/n8n/webhook/inbound`;
```
To:
```typescript
const inboundWebhookUrl = `${API_URL}/v1/webhooks/inbound`;
```

- [ ] **Step 4: Rename docs file**

```bash
cd chatbot-platform && git mv docs/n8n-integration.md docs/webhook-integration.md
```

Update any internal references within the file from "n8n" to "Webhook Integration" where they refer to the generic system (keep n8n references that are specifically about n8n workflows).

- [ ] **Step 5: Update server.ts imports**

In `api/src/server.ts`, update the import to use the new name:
```typescript
import { createWebhookModule } from './n8n';
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add api/src/n8n/index.ts api/src/n8n/outbound.service.ts api/src/server.ts portal/src/pages/Settings.tsx docs/webhook-integration.md
git commit -m "refactor: rename n8n references to generic webhook naming"
```

---

## Task 3: Remove Stub Endpoints

**Files:**
- Modify: `api/src/n8n/webhook.routes.ts:165-250` (remove register/unregister/registered)
- Modify: `api/src/n8n/webhook.controller.ts` (remove related controller methods if any)

- [ ] **Step 1: Remove stub routes**

In `api/src/n8n/webhook.routes.ts`, remove:
- `POST /register` (line 165)
- `DELETE /unregister/:webhookId` (line 204)
- `GET /registered` (line 226)

These are stub endpoints that return hardcoded responses with no DB backing.

- [ ] **Step 2: Remove associated controller methods if they exist**

Check `api/src/n8n/webhook.controller.ts` for any methods only used by the removed stubs and remove them.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/n8n/webhook.routes.ts api/src/n8n/webhook.controller.ts
git commit -m "chore: remove stub register/unregister webhook endpoints"
```

---

## Task 4: WebhookDeliveryLog Entity

**Files:**
- Create: `api/src/database/entities/WebhookDeliveryLog.ts`
- Reference: `api/src/database/entities/Tenant.ts:24-25` (for FK relation)

- [ ] **Step 1: Create the entity**

Create `api/src/database/entities/WebhookDeliveryLog.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Tenant } from './Tenant';

@Entity('webhook_delivery_logs')
@Index(['tenantId', 'createdAt'])
export class WebhookDeliveryLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @Column({ type: 'varchar', length: 100 })
  event!: string;

  @Column({ type: 'enum', enum: ['inbound', 'outbound'] })
  direction!: 'inbound' | 'outbound';

  @Column({ type: 'varchar', length: 500 })
  url!: string;

  @Column({ type: 'enum', enum: ['success', 'failed', 'retrying', 'dropped'] })
  status!: 'success' | 'failed' | 'retrying' | 'dropped';

  @Column({ type: 'int', nullable: true, name: 'http_status' })
  httpStatus?: number;

  @Column({ type: 'int', name: 'duration_ms', default: 0 })
  durationMs!: number;

  @Column({ type: 'text', nullable: true })
  error?: string;

  @Column({ type: 'jsonb', nullable: true, name: 'request_body' })
  requestBody?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
```

- [ ] **Step 2: Register entity in data source**

Check where entities are registered (likely in the TypeORM data source config) and add `WebhookDeliveryLog` to the entity list.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/database/entities/WebhookDeliveryLog.ts
git commit -m "feat: add WebhookDeliveryLog entity"
```

---

## Task 5: WebhookDeliveryLog Migration

**Files:**
- Create: `api/src/database/migrations/<timestamp>-CreateWebhookDeliveryLog.ts`

- [ ] **Step 1: Generate the migration**

Run: `cd chatbot-platform/api && npx typeorm migration:create src/database/migrations/CreateWebhookDeliveryLog`

- [ ] **Step 2: Write the migration**

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWebhookDeliveryLog<timestamp> implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum types
    await queryRunner.query(`
      CREATE TYPE webhook_delivery_direction AS ENUM ('inbound', 'outbound')
    `);
    await queryRunner.query(`
      CREATE TYPE webhook_delivery_status AS ENUM ('success', 'failed', 'retrying', 'dropped')
    `);

    await queryRunner.query(`
      CREATE TABLE webhook_delivery_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        event VARCHAR(100) NOT NULL,
        direction webhook_delivery_direction NOT NULL,
        url VARCHAR(500) NOT NULL,
        status webhook_delivery_status NOT NULL,
        http_status INT,
        duration_ms INT NOT NULL DEFAULT 0,
        error TEXT,
        request_body JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_webhook_delivery_tenant_created
      ON webhook_delivery_logs (tenant_id, created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS webhook_delivery_logs`);
    await queryRunner.query(`DROP TYPE IF EXISTS webhook_delivery_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS webhook_delivery_direction`);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add api/src/database/migrations/
git commit -m "feat: add migration for webhook_delivery_logs table"
```

---

## Task 6: Delivery Log Writes — Outbound Service

**Files:**
- Modify: `api/src/n8n/outbound.service.ts:120` (sendToWebhook method)
- Reference: `api/src/database/entities/WebhookDeliveryLog.ts`

- [ ] **Step 1: Import the entity and data source**

In `api/src/n8n/outbound.service.ts`, add:

```typescript
import { AppDataSource } from '../database/data-source';
import { WebhookDeliveryLog } from '../database/entities/WebhookDeliveryLog';
```

- [ ] **Step 2: Add delivery log helper**

Add a private method to the `OutboundService` class:

```typescript
private async logDelivery(
  tenantId: string,
  event: string,
  url: string,
  status: 'success' | 'failed' | 'retrying' | 'dropped',
  durationMs: number,
  httpStatus?: number,
  error?: string,
  requestBody?: Record<string, unknown>
): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(WebhookDeliveryLog);

    // Truncate request body to ~2KB for storage
    let truncatedBody = requestBody;
    if (requestBody) {
      const bodyStr = JSON.stringify(requestBody);
      if (bodyStr.length > 2048) {
        truncatedBody = { _truncated: true, preview: bodyStr.slice(0, 2048) } as any;
      }
    }

    await repo.save(repo.create({
      tenantId,
      event,
      direction: 'outbound',
      url,
      status,
      httpStatus,
      durationMs,
      error,
      requestBody: truncatedBody,
    }));

    // Rolling delete: cap at 500 entries per tenant
    const count = await repo.count({ where: { tenantId } });
    if (count > 500) {
      const oldest = await repo.find({
        where: { tenantId },
        order: { createdAt: 'ASC' },
        take: count - 500,
        select: ['id'],
      });
      if (oldest.length > 0) {
        await repo.delete(oldest.map(e => e.id));
      }
    }
  } catch (err) {
    // Non-blocking — don't fail the delivery because of log writes
    logger.warn('Failed to write delivery log', { error: err });
  }
}
```

- [ ] **Step 3: Wire into sendToWebhook**

In the `sendToWebhook` method (~line 120), add `logDelivery()` calls after each HTTP attempt:

After a successful HTTP response:
```typescript
await this.logDelivery(tenantId, event, url, 'success', durationMs, response.status, undefined, payload);
```

After a failed HTTP response:
```typescript
await this.logDelivery(tenantId, event, url, 'failed', durationMs, response?.status, errorMessage, payload);
```

When circuit breaker is open (message dropped/fallback):
```typescript
await this.logDelivery(tenantId, event, url, 'dropped', 0, undefined, 'Circuit breaker open');
```

When queued for retry:
```typescript
await this.logDelivery(tenantId, event, url, 'retrying', durationMs, response?.status, errorMessage, payload);
```

**Important:** Read the full `sendToWebhook` method first to understand the exact control flow (success path, failure path, circuit breaker check, retry queue). Place log calls at each exit point.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add api/src/n8n/outbound.service.ts
git commit -m "feat: add delivery log writes to outbound webhook service"
```

---

## Task 7: Delivery Log Writes — Inbound Controller

**Files:**
- Modify: `api/src/n8n/webhook.controller.ts:44` (handleInboundWebhook method)

- [ ] **Step 1: Import the entity and data source**

In `api/src/n8n/webhook.controller.ts`, add:

```typescript
import { AppDataSource } from '../database/data-source';
import { WebhookDeliveryLog } from '../database/entities/WebhookDeliveryLog';
```

- [ ] **Step 2: Add delivery logging to inbound handler**

In `handleInboundWebhook` (~line 44), after processing completes (success or failure), log the delivery:

At the end of successful processing:
```typescript
const repo = AppDataSource.getRepository(WebhookDeliveryLog);
await repo.save(repo.create({
  tenantId,
  event: action,
  direction: 'inbound',
  url: req.originalUrl,
  status: 'success',
  httpStatus: 200,
  durationMs: Date.now() - startTime,
  requestBody: truncateBody(req.body),
}));
```

In catch blocks / validation failures:
```typescript
await repo.save(repo.create({
  tenantId: tenantId || 'unknown',
  event: action || 'unknown',
  direction: 'inbound',
  url: req.originalUrl,
  status: 'failed',
  httpStatus: statusCode,
  durationMs: Date.now() - startTime,
  error: errorMessage,
  requestBody: truncateBody(req.body),
}));
```

Add `const startTime = Date.now();` at the top of the handler.

Add a helper to truncate the body:
```typescript
function truncateBody(body: unknown): Record<string, unknown> | undefined {
  if (!body) return undefined;
  const str = JSON.stringify(body);
  if (str.length > 2048) return { _truncated: true, preview: str.slice(0, 2048) };
  return body as Record<string, unknown>;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/n8n/webhook.controller.ts
git commit -m "feat: add delivery log writes to inbound webhook controller"
```

---

## Task 8: Webhook Admin API Endpoints

**Files:**
- Create: `api/src/routes/webhook-admin.routes.ts`
- Modify: `api/src/server.ts` (mount the new routes)

- [ ] **Step 1: Create webhook admin routes**

Create `api/src/routes/webhook-admin.routes.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { WebhookDeliveryLog } from '../database/entities/WebhookDeliveryLog';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { logger } from '../utils/logger';
import axios from 'axios';

const router = Router();

// GET /api/v1/tenants/me/webhooks/deliveries — paginated delivery log
router.get('/deliveries', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });

    const params = parsePaginationParams(req.query);
    const qb = AppDataSource.getRepository(WebhookDeliveryLog)
      .createQueryBuilder('log')
      .where('log.tenantId = :tenantId', { tenantId })
      .orderBy('log.createdAt', 'DESC');

    const result = await applyPagination(qb, params);
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Failed to fetch delivery logs', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/tenants/me/webhooks/status — health + circuit breaker state
router.get('/status', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });

    // Get last delivery for this tenant
    const repo = AppDataSource.getRepository(WebhookDeliveryLog);
    const lastDelivery = await repo.findOne({
      where: { tenantId, direction: 'outbound' },
      order: { createdAt: 'DESC' },
    });

    const lastSuccess = await repo.findOne({
      where: { tenantId, direction: 'outbound', status: 'success' },
      order: { createdAt: 'DESC' },
    });

    // Get circuit breaker status from the webhook module health endpoint
    let circuitState = 'unknown';
    try {
      const healthRes = await axios.get(`http://localhost:${process.env.PORT || 3000}/api/v1/webhooks/circuit-status`);
      circuitState = healthRes.data?.state || 'unknown';
    } catch {
      circuitState = 'unknown';
    }

    // Determine health indicator
    let health: 'green' | 'yellow' | 'red' = 'green';
    if (circuitState === 'OPEN' || (lastDelivery && lastDelivery.status === 'failed')) {
      health = 'red';
    } else if (circuitState === 'HALF_OPEN') {
      health = 'yellow';
    } else if (!lastDelivery) {
      health = 'yellow'; // No deliveries yet
    }

    return res.json({
      success: true,
      data: {
        health,
        circuitState,
        lastDelivery: lastDelivery ? {
          status: lastDelivery.status,
          httpStatus: lastDelivery.httpStatus,
          createdAt: lastDelivery.createdAt,
          durationMs: lastDelivery.durationMs,
        } : null,
        lastSuccessAt: lastSuccess?.createdAt || null,
      },
    });
  } catch (error) {
    logger.error('Failed to fetch webhook status', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v1/tenants/me/webhooks/test — send test ping
router.post('/test', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) return res.status(401).json({ error: 'Unauthorized' });

    const tenantRepo = AppDataSource.getRepository('Tenant');
    const tenant = await tenantRepo.findOne({ where: { id: tenantId } });

    if (!tenant?.webhookUrl) {
      return res.status(400).json({ error: 'No webhook URL configured' });
    }

    const startTime = Date.now();
    try {
      const response = await axios.post(tenant.webhookUrl, {
        event: 'webhook.test',
        tenantId,
        payload: { message: 'Test ping from chatbot platform' },
        timestamp: new Date().toISOString(),
      }, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          ...(tenant.webhookSecret ? { 'X-Webhook-Secret': tenant.webhookSecret } : {}),
        },
      });

      const durationMs = Date.now() - startTime;

      // Log successful test
      const logRepo = AppDataSource.getRepository(WebhookDeliveryLog);
      await logRepo.save(logRepo.create({
        tenantId,
        event: 'webhook.test',
        direction: 'outbound',
        url: tenant.webhookUrl,
        status: 'success',
        httpStatus: response.status,
        durationMs,
      }));

      return res.json({
        success: true,
        data: { status: response.status, durationMs },
      });
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const axiosErr = err as { response?: { status: number }; message?: string };

      // Log failed test
      const logRepo = AppDataSource.getRepository(WebhookDeliveryLog);
      await logRepo.save(logRepo.create({
        tenantId,
        event: 'webhook.test',
        direction: 'outbound',
        url: tenant.webhookUrl,
        status: 'failed',
        httpStatus: axiosErr.response?.status,
        durationMs,
        error: axiosErr.message || 'Unknown error',
      }));

      return res.json({
        success: false,
        data: {
          status: axiosErr.response?.status || 0,
          durationMs,
          error: axiosErr.message,
        },
      });
    }
  } catch (error) {
    logger.error('Failed to send test webhook', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
```

**Important:** Read the actual codebase to check:
- Whether `parsePaginationParams` / `applyPagination` exist yet (from the pagination plan). If not, use manual offset/limit logic.
- Whether `axios` is already a dependency. If not, use the HTTP client from the outbound service or install axios.
- How the circuit breaker state is exposed (it may be accessible directly from the module instance instead of via HTTP).

- [ ] **Step 2: Mount the routes in server.ts**

In `api/src/server.ts`, add inside the apiRouter setup:

```typescript
import webhookAdminRoutes from './routes/webhook-admin.routes';

// Mount under tenants/me/webhooks — requires auth
apiRouter.use('/tenants/me/webhooks', requireClerkAuth, webhookAdminRoutes);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd chatbot-platform/api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/webhook-admin.routes.ts api/src/server.ts
git commit -m "feat: add webhook admin endpoints (status, deliveries, test)"
```

---

## Task 9: Portal UI — Extract & Enhance Integration Tab

**Files:**
- Create: `portal/src/components/settings/IntegrationTab.tsx`
- Modify: `portal/src/pages/Settings.tsx:250-500+` (replace inline Integration tab)

- [ ] **Step 1: Create the IntegrationTab component**

Create `portal/src/components/settings/IntegrationTab.tsx`. This component includes:

**Section A — Connection Configuration:**
- Webhook URL input field (relocate from current integration tab)
- Webhook Secret display (masked with copy button)
- Regenerate Secret button
- Save button

**Section B — Connection Health status card:**
```tsx
// Fetch from GET /api/v1/tenants/me/webhooks/status
const { data: statusData } = useQuery({
  queryKey: ['webhook-status'],
  queryFn: () => api.get('/tenants/me/webhooks/status'),
  refetchInterval: 30000, // poll every 30s
});
```

Display:
- Health indicator dot (green/yellow/red) based on `statusData.health`
- Circuit breaker state badge (CLOSED/OPEN/HALF_OPEN)
- Last successful delivery timestamp + duration
- "Test Webhook" button that POSTs to `/tenants/me/webhooks/test` and shows result inline

**Section C — Delivery Log table:**
```tsx
// Fetch from GET /api/v1/tenants/me/webhooks/deliveries?page=1&limit=20
const { data: deliveries } = useQuery({
  queryKey: ['webhook-deliveries', page],
  queryFn: () => api.get(`/tenants/me/webhooks/deliveries?page=${page}&limit=20`),
});
```

Table columns:
- Time — relative timestamp ("2 min ago") using `formatDistanceToNow` or similar
- Direction — Inbound/Outbound badge
- Event — event name string
- Status — colored badge (green=success, red=failed, yellow=retrying)
- HTTP Status — number
- Duration — e.g. "120ms"
- Error — truncated, expandable on click

Use the existing Pagination component if available, otherwise add prev/next buttons.

**Important:** Read the current `Settings.tsx` Integration tab code (lines ~250-500) to understand:
- How `api` is imported and used
- How tenant data is fetched (the existing `useQuery`)
- The existing save/regenerate handlers (lines 140-184)
- The Tailwind classes and UI patterns used throughout Settings

Mirror the existing styles exactly.

- [ ] **Step 2: Replace inline integration tab in Settings.tsx**

In `portal/src/pages/Settings.tsx`, replace the `<TabsContent value="integration">` block with:

```tsx
import { IntegrationTab } from '../components/settings/IntegrationTab';

// In the JSX:
<TabsContent value="integration">
  <IntegrationTab />
</TabsContent>
```

Move the relevant state and handlers (`webhookUrlInput`, `handleSaveWebhookUrl`, `handleTestWebhook`, `handleRegenerateSecret`) into the IntegrationTab component.

- [ ] **Step 3: Verify frontend compiles**

Run: `cd chatbot-platform/portal && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/settings/IntegrationTab.tsx portal/src/pages/Settings.tsx
git commit -m "feat: enhance integration tab with health status and delivery log"
```

---

## Task 10: Integration Tests

**Files:**
- Create: `api/src/__tests__/integration/webhook.test.ts` (if test infrastructure exists)

- [ ] **Step 1: Write inbound webhook integration test**

If test infrastructure from the earlier plan is set up, create `api/src/__tests__/integration/webhook.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../app';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';

describe('Webhook Integration', () => {
  let tenant: Tenant;

  beforeEach(async () => {
    const repo = AppDataSource.getRepository(Tenant);
    tenant = await repo.save(repo.create({
      name: 'Test Tenant',
      webhookSecret: 'test-secret-123',
    }));
  });

  describe('POST /api/v1/webhooks/inbound', () => {
    it('should reject requests without a valid secret', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks/inbound')
        .send({
          action: 'message.send',
          tenantId: tenant.id,
          sessionId: 'some-session',
          payload: { content: 'Hello' },
        });

      expect(res.status).toBe(401);
    });

    it('should reject invalid action types', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks/inbound')
        .set('X-Webhook-Secret', 'test-secret-123')
        .send({
          action: 'invalid.action',
          tenantId: tenant.id,
          sessionId: 'some-session',
          payload: {},
        });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/tenants/me/webhooks/test', () => {
    it('should return failure when webhook URL is not configured', async () => {
      const res = await request(app)
        .post('/api/v1/tenants/me/webhooks/test')
        .set('Authorization', 'Bearer test-token');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('No webhook URL');
    });
  });
});
```

**Note:** If test infrastructure is not yet set up (Task 16-19 from the roadmap plan), skip this task and document it as pending.

- [ ] **Step 2: Run tests**

Run: `cd chatbot-platform/api && npx vitest run src/__tests__/integration/webhook.test.ts`

- [ ] **Step 3: Commit**

```bash
git add api/src/__tests__/integration/webhook.test.ts
git commit -m "test: add integration tests for webhook endpoints"
```

---

## Task 11: Manual E2E Verification

- [ ] **Step 1: Start the platform locally**

Run: `cd chatbot-platform/api && npm run dev`

Verify in logs:
- "Webhook integration module initialized"
- No errors related to n8n/webhook module

- [ ] **Step 2: Verify endpoints are reachable**

```bash
# Health check
curl http://localhost:3000/api/v1/webhooks/health

# Circuit status (should return CLOSED)
curl http://localhost:3000/api/v1/webhooks/circuit-status
```

- [ ] **Step 3: Test webhook from portal**

1. Open portal Settings → Integration tab
2. Enter a test webhook URL (use https://webhook.site for testing)
3. Click "Test Webhook"
4. Verify the test ping appears on webhook.site
5. Verify the delivery log table shows the test entry

- [ ] **Step 4: Test inbound webhook**

```bash
curl -X POST http://localhost:3000/api/v1/webhooks/inbound \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <your-tenant-secret>" \
  -d '{
    "action": "message.send",
    "tenantId": "<your-tenant-id>",
    "sessionId": "<active-session-id>",
    "payload": {
      "type": "text",
      "content": "Hello from automation!"
    }
  }'
```

Verify the message appears in the widget chat.

- [ ] **Step 5: Verify delivery log in portal**

Check the Integration tab delivery log table shows entries for both outbound and inbound deliveries.

---

## Execution Order

```
Task 1: Boot & Wire → Task 2: Rename → Task 3: Remove Stubs → Task 4: Entity → Task 5: Migration
  → Task 6: Outbound Logging → Task 7: Inbound Logging → Task 8: Admin API → Task 9: Portal UI
    → Task 10: Tests → Task 11: E2E Verification
```

All tasks are sequential — each builds on the previous. The critical path is Tasks 1-3 (get the module running), then 4-7 (delivery log), then 8-9 (UI).
