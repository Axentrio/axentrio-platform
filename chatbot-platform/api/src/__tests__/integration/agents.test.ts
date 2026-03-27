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
  createTestAgent,
} from '../helpers/factories';

describe('Agent Management', () => {
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

  describe('GET /api/v1/agents', () => {
    it('should list agents for the tenant', async () => {
      const user1 = await createTestUser(tenantId);
      const user2 = await createTestUser(tenantId);
      const user3 = await createTestUser(tenantId);
      await createTestAgent(tenantId, user1.id);
      await createTestAgent(tenantId, user2.id);
      await createTestAgent(tenantId, user3.id);

      const res = await request(app).get('/api/v1/agents');

      expect(res.status).toBe(200);
      expect(res.body.data.agents.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('POST /api/v1/agents', () => {
    it('should create an agent with offline status', async () => {
      const user = await createTestUser(tenantId);

      const res = await request(app)
        .post('/api/v1/agents')
        .send({ userId: user.id });

      expect(res.status).toBe(201);
      expect(res.body.data.agent.status).toBe('offline');
      expect(res.body.data.agent.userId).toBe(user.id);
    });
  });

  describe('PATCH /api/v1/agents/:id/status', () => {
    it('should update agent status to online', async () => {
      const user = await createTestUser(tenantId);
      const agent = await createTestAgent(tenantId, user.id, { status: 'offline' });

      const res = await request(app)
        .patch(`/api/v1/agents/${agent.id}/status`)
        .send({ status: 'online' });

      expect(res.status).toBe(200);
      expect(res.body.data.agent.status).toBe('online');
    });
  });
});
