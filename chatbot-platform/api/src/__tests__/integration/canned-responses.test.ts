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
