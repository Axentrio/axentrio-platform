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
import { AppDataSource } from '../../database/data-source';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
import {
  createTestTenant,
  createTestUser,
  createTestAgent,
  createTestSession,
  createTestHandoffRequest,
} from '../helpers/factories';

describe('Handoff Flow', () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;

    const user = await createTestUser(tenantId, { role: 'admin' });
    const agent = await createTestAgent(tenantId, user.id);

    configureMockAuth(auth, {
      userId: agent.id,
      tenantId,
      role: 'admin',
    });
  });

  describe('POST /api/v1/handoffs/:id/accept', () => {
    it('should accept a handoff request', async () => {
      const session = await createTestSession(tenantId, { status: 'handoff' });
      const handoff = await createTestHandoffRequest(session.id, tenantId);

      const res = await request(app)
        .post(`/api/v1/handoffs/${handoff.id}/accept`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data.handoff.status).toBe('accepted');

      const updated = await AppDataSource.getRepository(HandoffRequest).findOneBy({ id: handoff.id });
      expect(updated!.status).toBe('accepted');
    });

    it('should return 404 for non-existent handoff', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000099';

      const res = await request(app)
        .post(`/api/v1/handoffs/${fakeId}/accept`)
        .send();

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/handoffs/:id/decline', () => {
    it('should decline a handoff request', async () => {
      const session = await createTestSession(tenantId, { status: 'handoff' });
      const handoff = await createTestHandoffRequest(session.id, tenantId);

      const res = await request(app)
        .post(`/api/v1/handoffs/${handoff.id}/decline`)
        .send({ reason: 'Not available' });

      expect(res.status).toBe(200);
      expect(res.body.data.handoff.status).toBe('rejected');

      const updated = await AppDataSource.getRepository(HandoffRequest).findOneBy({ id: handoff.id });
      expect(updated!.status).toBe('rejected');
    });
  });

  describe('GET /api/v1/handoffs/queue', () => {
    it('should return only requested handoffs in the queue', async () => {
      const session1 = await createTestSession(tenantId, { status: 'handoff' });
      const session2 = await createTestSession(tenantId, { status: 'handoff' });
      const session3 = await createTestSession(tenantId, { status: 'active' });

      await createTestHandoffRequest(session1.id, tenantId, { status: 'requested' });
      await createTestHandoffRequest(session2.id, tenantId, { status: 'requested' });
      await createTestHandoffRequest(session3.id, tenantId, { status: 'accepted' });

      const res = await request(app)
        .get('/api/v1/handoffs/queue');

      expect(res.status).toBe(200);
      expect(res.body.data.queue).toHaveLength(2);
    });
  });
});
