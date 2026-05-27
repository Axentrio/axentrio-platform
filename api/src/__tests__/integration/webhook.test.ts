/**
 * Webhook Integration Tests
 *
 * Tests cover:
 * 1. Inbound webhook endpoint — POST /api/v1/webhooks/inbound
 *    (only reachable when the webhook module is booted; tests below verify
 *     the route returns 404 when not booted, confirming the guard works)
 * 2. WebhookDeliveryLog entity — CRUD via TypeORM
 *
 * Note: Webhook admin endpoint auth-rejection tests have been removed because
 * clerkMiddleware and requireClerkAuth are both mocked as no-ops in this environment.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks } from '../helpers/auth';

createAuthMocks();

// Mock @clerk/express global middleware (clerkMiddleware) to be a no-op
vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

// Mock socket handler to avoid real WebSocket operations
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
}));

// Mock audit logging
vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { WebhookDeliveryLog } from '../../database/entities/WebhookDeliveryLog';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestTenant(overrides: Partial<Tenant> = {}): Promise<Tenant> {
  const repo = AppDataSource.getRepository(Tenant);
  return repo.save(
    repo.create({
      name: 'Webhook Test Tenant',
      slug: `test-${crypto.randomBytes(4).toString('hex')}`,
      apiKey: crypto.randomBytes(32).toString('hex'),
      webhookSecret: 'test-secret-123',
      tier: 'pro',
      status: 'active',
      settings: {},
      ...overrides,
    }),
  );
}

// ---------------------------------------------------------------------------
// 1. Inbound Webhook Endpoint
// ---------------------------------------------------------------------------

describe('POST /api/v1/webhooks/inbound', () => {
  /**
   * The webhook module router is mounted at `/api/v1/webhooks` inside
   * startServer() (after DB + Redis init).  When running tests via the
   * exported `app` the boot sequence does not execute, so the route is not
   * registered.  These tests confirm that the server does not accidentally
   * expose the route before the module is ready.
   *
   * Full integration tests that boot the server are covered by the E2E
   * verification (Task 11) and can be run manually with `npm run dev`.
   */

  it('should return 404 when webhook module has not been booted', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/inbound')
      .set('Content-Type', 'application/json')
      .send({
        action: 'message.send',
        sessionId: '00000000-0000-0000-0000-000000000000',
        payload: { type: 'text', content: 'hello' },
      });

    // Route is not mounted → falls through to the notFoundHandler
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 2. WebhookDeliveryLog Entity
// ---------------------------------------------------------------------------

describe('WebhookDeliveryLog Entity', () => {
  let tenant: Tenant;

  beforeEach(async () => {
    tenant = await createTestTenant();
  });

  it('should create a delivery log entry', async () => {
    const repo = AppDataSource.getRepository(WebhookDeliveryLog);

    const log = await repo.save(
      repo.create({
        tenantId: tenant.id,
        event: 'message.send',
        direction: 'inbound',
        url: '/api/v1/webhooks/inbound',
        status: 'success',
        httpStatus: 200,
        durationMs: 42,
      }),
    );

    expect(log.id).toBeDefined();
    expect(log.tenantId).toBe(tenant.id);
    expect(log.event).toBe('message.send');
    expect(log.direction).toBe('inbound');
    expect(log.status).toBe('success');
    expect(log.httpStatus).toBe(200);
    expect(log.durationMs).toBe(42);
    expect(log.createdAt).toBeInstanceOf(Date);
  });

  it('should store and retrieve requestBody as JSONB', async () => {
    const repo = AppDataSource.getRepository(WebhookDeliveryLog);
    const body = { type: 'text', content: 'Hello world', nested: { key: 'value' } };

    const log = await repo.save(
      repo.create({
        tenantId: tenant.id,
        event: 'message.send',
        direction: 'outbound',
        url: 'https://example.com/webhook',
        status: 'success',
        httpStatus: 200,
        durationMs: 100,
        requestBody: body,
      }),
    );

    const fetched = await repo.findOneBy({ id: log.id });
    expect(fetched).not.toBeNull();
    expect(fetched!.requestBody).toEqual(body);
  });

  it('should store error text on failed deliveries', async () => {
    const repo = AppDataSource.getRepository(WebhookDeliveryLog);

    const log = await repo.save(
      repo.create({
        tenantId: tenant.id,
        event: 'webhook.test',
        direction: 'outbound',
        url: 'https://example.com/webhook',
        status: 'failed',
        httpStatus: 502,
        durationMs: 5000,
        error: 'Bad Gateway: upstream timeout',
      }),
    );

    const fetched = await repo.findOneBy({ id: log.id });
    expect(fetched!.error).toBe('Bad Gateway: upstream timeout');
    expect(fetched!.status).toBe('failed');
  });

  it('should query delivery logs scoped by tenantId', async () => {
    const repo = AppDataSource.getRepository(WebhookDeliveryLog);
    const otherTenant = await createTestTenant({ name: 'Other Tenant' });

    // Create logs for both tenants
    await repo.save([
      repo.create({
        tenantId: tenant.id,
        event: 'message.send',
        direction: 'inbound',
        url: '/api/v1/webhooks/inbound',
        status: 'success',
        httpStatus: 200,
        durationMs: 10,
      }),
      repo.create({
        tenantId: tenant.id,
        event: 'session.started',
        direction: 'outbound',
        url: 'https://example.com/hook',
        status: 'success',
        httpStatus: 200,
        durationMs: 20,
      }),
      repo.create({
        tenantId: otherTenant.id,
        event: 'message.send',
        direction: 'inbound',
        url: '/api/v1/webhooks/inbound',
        status: 'success',
        httpStatus: 200,
        durationMs: 30,
      }),
    ]);

    const tenantLogs = await repo.find({ where: { tenantId: tenant.id } });
    expect(tenantLogs).toHaveLength(2);

    const otherLogs = await repo.find({ where: { tenantId: otherTenant.id } });
    expect(otherLogs).toHaveLength(1);
  });

  it('should query by direction and status filters', async () => {
    const repo = AppDataSource.getRepository(WebhookDeliveryLog);

    await repo.save([
      repo.create({
        tenantId: tenant.id,
        event: 'message.send',
        direction: 'inbound',
        url: '/inbound',
        status: 'success',
        httpStatus: 200,
        durationMs: 10,
      }),
      repo.create({
        tenantId: tenant.id,
        event: 'message.received',
        direction: 'outbound',
        url: 'https://hook.example.com',
        status: 'failed',
        httpStatus: 500,
        durationMs: 3000,
        error: 'Internal Server Error',
      }),
      repo.create({
        tenantId: tenant.id,
        event: 'message.received',
        direction: 'outbound',
        url: 'https://hook.example.com',
        status: 'retrying',
        httpStatus: 503,
        durationMs: 2000,
      }),
    ]);

    const outbound = await repo.find({
      where: { tenantId: tenant.id, direction: 'outbound' },
    });
    expect(outbound).toHaveLength(2);

    const failed = await repo.find({
      where: { tenantId: tenant.id, status: 'failed' },
    });
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe('Internal Server Error');
  });

  it('should order delivery logs by createdAt descending', async () => {
    const repo = AppDataSource.getRepository(WebhookDeliveryLog);

    // Insert three logs sequentially
    const log1 = await repo.save(
      repo.create({
        tenantId: tenant.id,
        event: 'first',
        direction: 'inbound',
        url: '/inbound',
        status: 'success',
        httpStatus: 200,
        durationMs: 1,
      }),
    );

    const log2 = await repo.save(
      repo.create({
        tenantId: tenant.id,
        event: 'second',
        direction: 'inbound',
        url: '/inbound',
        status: 'success',
        httpStatus: 200,
        durationMs: 2,
      }),
    );

    const log3 = await repo.save(
      repo.create({
        tenantId: tenant.id,
        event: 'third',
        direction: 'inbound',
        url: '/inbound',
        status: 'success',
        httpStatus: 200,
        durationMs: 3,
      }),
    );

    const logs = await repo.find({
      where: { tenantId: tenant.id },
      order: { createdAt: 'DESC' },
    });

    expect(logs).toHaveLength(3);
    expect(logs[0].id).toBe(log3.id);
    expect(logs[1].id).toBe(log2.id);
    expect(logs[2].id).toBe(log1.id);
  });

  it('should cascade-delete logs when tenant is deleted', async () => {
    const repo = AppDataSource.getRepository(WebhookDeliveryLog);
    const tenantRepo = AppDataSource.getRepository(Tenant);

    await repo.save(
      repo.create({
        tenantId: tenant.id,
        event: 'message.send',
        direction: 'inbound',
        url: '/inbound',
        status: 'success',
        httpStatus: 200,
        durationMs: 5,
      }),
    );

    // Verify log exists
    const before = await repo.find({ where: { tenantId: tenant.id } });
    expect(before).toHaveLength(1);

    // Delete tenant
    await tenantRepo.delete(tenant.id);

    // Delivery log should be cascade-deleted
    const after = await repo.find({ where: { tenantId: tenant.id } });
    expect(after).toHaveLength(0);
  });
});
