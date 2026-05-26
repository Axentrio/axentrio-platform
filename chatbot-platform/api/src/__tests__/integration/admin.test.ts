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
import { BillingEvent } from '../../database/entities/BillingEvent';
import {
  createTestTenant,
  createTestUser,
  createTestPendingInvite,
  createTestBillingAccount,
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

  describe('POST /api/v1/admin/tenants/:id/set-tier — forced Stripe disposition', () => {
    async function giveActiveStripeSub(tid: string) {
      await createTestBillingAccount(tid, {
        provider: 'stripe',
        status: 'active',
        currentPlanId: 'pro',
        subscriptionId: `sub_${tid.slice(0, 8)}`,
        isPrimary: true,
      });
    }

    it('rejects override→free with an active Stripe sub and no disposition (400)', async () => {
      await giveActiveStripeSub(tenantId);

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${tenantId}/set-tier`)
        .send({ tier: 'free' });

      expect(res.status).toBe(400);
    });

    it('rejects leave_active without a reason (400)', async () => {
      await giveActiveStripeSub(tenantId);

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${tenantId}/set-tier`)
        .send({ tier: 'free', stripeDisposition: 'leave_active', dispositionReason: '   ' });

      expect(res.status).toBe(400);
    });

    it('accepts will_cancel and records it on the tier.manual_override event', async () => {
      await giveActiveStripeSub(tenantId);

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${tenantId}/set-tier`)
        .send({ tier: 'free', stripeDisposition: 'will_cancel' });

      expect(res.status).toBe(200);

      const events = await AppDataSource.getRepository(BillingEvent).find({
        where: { tenantId, eventType: 'tier.manual_override' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        newTier: 'free',
        stripeDisposition: 'will_cancel',
      });
    });

    it('does not require a disposition when no live Stripe sub exists', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/tenants/${tenantId}/set-tier`)
        .send({ tier: 'free' });

      expect(res.status).toBe(200);
    });

    it('GET /tenants exposes hasActiveStripeSubscription', async () => {
      await giveActiveStripeSub(tenantId);

      const res = await request(app).get('/api/v1/admin/tenants');

      expect(res.status).toBe(200);
      const row = (res.body.data as Array<{ id: string; hasActiveStripeSubscription?: boolean }>)
        .find((t) => t.id === tenantId);
      expect(row?.hasActiveStripeSubscription).toBe(true);
    });
  });
});
