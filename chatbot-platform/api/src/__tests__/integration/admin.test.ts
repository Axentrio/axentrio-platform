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
import { PendingInvite } from '../../database/entities/PendingInvite';
import {
  createTestTenant,
  createTestUser,
  createTestPendingInvite,
} from '../helpers/factories';

describe('Admin Invite Resend/Cancel', () => {
  let tenantId: string;

  let adminId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ clerkOrgId: 'org_test123' });
    tenantId = tenant.id;

    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    adminId = admin.id;

    configureMockAuth(auth, {
      userId: admin.id,
      tenantId,
      role: 'super_admin',
    });
  });

  describe('POST /api/v1/admin/tenants/:tenantId/pending-invites/:inviteId/resend', () => {
    it('should resend an expired invite and reset expiresAt', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const invite = await createTestPendingInvite(tenantId, {
        expiresAt: pastDate,
        invitedBy: adminId,
      });

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${tenantId}/pending-invites/${invite.id}/resend`)
        .send();

      expect(res.status).toBe(200);
      expect(new Date(res.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('should return 404 for non-existent invite', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000099';

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${tenantId}/pending-invites/${fakeId}/resend`)
        .send();

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/admin/tenants/:tenantId/pending-invites/:inviteId', () => {
    it('should cancel an invite and remove it from DB', async () => {
      const invite = await createTestPendingInvite(tenantId, { invitedBy: adminId });

      const res = await request(app)
        .delete(`/api/v1/admin/tenants/${tenantId}/pending-invites/${invite.id}`)
        .send();

      expect(res.status).toBe(204);

      const found = await AppDataSource.getRepository(PendingInvite).findOneBy({ id: invite.id });
      expect(found).toBeNull();
    });

    it('should return 404 for non-existent invite', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000099';

      const res = await request(app)
        .delete(`/api/v1/admin/tenants/${tenantId}/pending-invites/${fakeId}`)
        .send();

      expect(res.status).toBe(404);
    });
  });
});
