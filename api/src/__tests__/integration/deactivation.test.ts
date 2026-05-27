import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

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
  let adminUser: User;

  beforeEach(async () => {
    const tenant = await createTestTenant();
    tenantId = tenant.id;

    // Create the admin who performs the deactivation
    adminUser = await createTestUser(tenantId, { role: 'admin' });

    configureMockAuth(auth, {
      userId: adminUser.id,
      tenantId,
      role: 'super_admin',
    });
  });

  describe('POST /api/v1/admin/users/:id/deactivate', () => {
    it('should deactivate user and set active sessions to waiting with null assignedAgentId', async () => {
      // Create target user + agent
      const targetUser = await createTestUser(tenantId, { role: 'agent' });
      const agent = await createTestAgent(tenantId, targetUser.id);

      // Create active sessions assigned to this agent
      const session1 = await createTestSession(tenantId, {
        status: 'active',
        assignedAgentId: agent.id,
      });
      const session2 = await createTestSession(tenantId, {
        status: 'active',
        assignedAgentId: agent.id,
      });

      const res = await request(app)
        .post(`/api/v1/admin/users/${targetUser.id}/deactivate`)
        .send();

      expect(res.status).toBe(200);

      // Verify user is deactivated
      const updatedUser = await AppDataSource.getRepository(User).findOneBy({ id: targetUser.id });
      expect(updatedUser!.isActive).toBe(false);

      // Verify sessions are now waiting with null assignedAgentId
      const sessionRepo = AppDataSource.getRepository(ChatSession);
      const s1 = await sessionRepo.findOneBy({ id: session1.id });
      const s2 = await sessionRepo.findOneBy({ id: session2.id });

      expect(s1!.status).toBe('waiting');
      expect(s1!.assignedAgentId).toBeNull();
      expect(s2!.status).toBe('waiting');
      expect(s2!.assignedAgentId).toBeNull();
    });

    it('should reset accepted handoff requests to requested with null assignedAgentId', async () => {
      const targetUser = await createTestUser(tenantId, { role: 'agent' });
      const agent = await createTestAgent(tenantId, targetUser.id);

      const session = await createTestSession(tenantId, {
        status: 'active',
        assignedAgentId: agent.id,
      });

      const handoff = await createTestHandoffRequest(session.id, tenantId, {
        status: 'accepted',
        assignedAgentId: agent.id,
      });

      const res = await request(app)
        .post(`/api/v1/admin/users/${targetUser.id}/deactivate`)
        .send();

      expect(res.status).toBe(200);

      // Verify handoff request is reset
      const updatedHandoff = await AppDataSource.getRepository(HandoffRequest).findOneBy({ id: handoff.id });
      expect(updatedHandoff!.status).toBe('requested');
      expect(updatedHandoff!.assignedAgentId).toBeNull();
    });

    it('should succeed when user has no agent record', async () => {
      // Create a user with no corresponding agent record
      const targetUser = await createTestUser(tenantId, { role: 'agent' });

      const res = await request(app)
        .post(`/api/v1/admin/users/${targetUser.id}/deactivate`)
        .send();

      expect(res.status).toBe(200);

      const updatedUser = await AppDataSource.getRepository(User).findOneBy({ id: targetUser.id });
      expect(updatedUser!.isActive).toBe(false);
    });

    it('should return 400 when deactivating an already-inactive user', async () => {
      const targetUser = await createTestUser(tenantId, { role: 'agent', isActive: false });

      const res = await request(app)
        .post(`/api/v1/admin/users/${targetUser.id}/deactivate`)
        .send();

      expect(res.status).toBe(400);
    });

    it('should return 400 when trying to deactivate yourself', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/users/${adminUser.id}/deactivate`)
        .send();

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/tenants/me/users/:userId/deactivate', () => {
    it('should return 400 when deactivating the last active admin in tenant', async () => {
      // The adminUser created in beforeEach is the only active admin
      // Create a second admin to be the caller (so they're not deactivating themselves)
      const callerAdmin = await createTestUser(tenantId, { role: 'admin' });

      configureMockAuth(auth, {
        userId: callerAdmin.id,
        tenantId,
        role: 'admin',
      });

      // Try to deactivate adminUser — who is the LAST remaining admin besides caller
      // Actually we now have 2 admins (adminUser + callerAdmin). We need exactly 1 active admin
      // to trigger the guard. So deactivate adminUser first (leaving callerAdmin as last),
      // then try to deactivate callerAdmin via a third user — but that's the self-deactivation case.
      //
      // Better approach: create a sole admin scenario.
      // Create a fresh tenant with exactly one admin.
      const soloTenant = await createTestTenant();
      const soloAdmin = await createTestUser(soloTenant.id, { role: 'admin' });
      const agentUser = await createTestUser(soloTenant.id, { role: 'agent' });

      // Use the agent user as caller (but they need admin role to access the endpoint)
      // The tenant route uses requireAdmin middleware, so we need admin or super_admin role.
      // We'll use super_admin in the mock to bypass the middleware check.
      configureMockAuth(auth, {
        userId: agentUser.id,
        tenantId: soloTenant.id,
        role: 'super_admin',
      });

      const res = await request(app)
        .post(`/api/v1/tenants/me/users/${soloAdmin.id}/deactivate`)
        .send();

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/last active admin/i);
    });
  });
});
