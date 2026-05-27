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
  createTestAnchorBot,
} from '../helpers/factories';

describe('Tenant Management', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;

    const admin = await createTestUser(tenantId, { role: 'admin' });

    configureMockAuth(auth, {
      userId: admin.id,
      tenantId,
      role: 'admin',
    });
  });

  describe('GET /api/v1/tenants/me', () => {
    it('should return current tenant details', async () => {
      const res = await request(app).get('/api/v1/tenants/me');

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(tenantId);
      expect(res.body.data.name).toBeDefined();
    });
  });

  describe('PATCH /api/v1/tenants/me', () => {
    it('should update webhook URL', async () => {
      const res = await request(app)
        .patch('/api/v1/tenants/me')
        .send({ webhookUrl: 'https://example.com/webhook' });

      expect(res.status).toBe(200);
      expect(res.body.data.webhookUrl).toBe('https://example.com/webhook');
    });
  });

  describe('POST /api/v1/admin/tenants/:id/api-key/rotate', () => {
    it('should rotate the API key and return the new key', async () => {
      // Admin route requires super_admin
      configureMockAuth(auth, {
        userId: auth.userId,
        tenantId,
        role: 'super_admin',
      });

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${tenantId}/api-key/rotate`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data.apiKey).toBeDefined();
      expect(typeof res.body.data.apiKey).toBe('string');
    });
  });

  describe('GET /api/v1/widget/config', () => {
    it('should return widget configuration for valid apiKey', async () => {
      const tenant = await createTestTenant({ name: 'Widget Test Tenant' });
      // Anchor bot is required for `resolveBotKey` to resolve the legacy
      // tenant.apiKey path — production tenants always have one via the
      // auto-provision flow.
      await createTestAnchorBot(tenant);

      const res = await request(app)
        .get('/api/v1/widget/config')
        .query({ apiKey: tenant.apiKey });

      expect(res.status).toBe(200);
      expect(res.body.data.tenantId).toBe(tenant.id);
      expect(res.body.data.name).toBe('Widget Test Tenant');
      expect(res.body.data.bot?.id).toBeDefined();
    });
  });
});
