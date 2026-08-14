/**
 * Admin feature-override write — the above-tier confirmation guard (Rule 4).
 *
 * PUT /api/v1/admin/tenants/:id/feature-overrides must:
 *  - reject a NEW above-plan grant (e.g. bookings on Essential) with a stable
 *    machine-readable code unless confirmAboveTier is sent;
 *  - accept it once confirmed;
 *  - stay backward-compatible with the legacy bare-map body (portal deploys
 *    independently), and NOT re-prompt when an unrelated setting changes while an
 *    existing above-tier comp is untouched;
 *  - not trip on an override that is within the plan (e.g. travelTime on Pro).
 *
 * Mirrors the auth/app-bootstrap pattern of entitlements-routes.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { vi as viHoist } from 'vitest';

const auth = viHoist.hoisted(() => ({
  userId: '',
  tenantId: '',
  agentId: '',
  role: 'super_admin' as string,
  email: 'test@example.com',
  clerkUserId: '',
  clerkOrgId: '',
}));

vi.mock('../../middleware/clerk.middleware', async () => {
  const { UnauthorizedError } = await import('../../middleware/error-handler');
  return {
    requireClerkAuth: (req: any, _res: any, next: any) => {
      if (!auth.userId) return next(new UnauthorizedError('Clerk: Unauthorized - no userId in auth'));
      req.userId = auth.userId;
      req.tenantId = auth.tenantId;
      req.agentId = auth.agentId;
      req.userRole = auth.role;
      req.user = {
        id: auth.userId,
        email: auth.email,
        role: auth.role,
        tenantId: auth.tenantId,
        clerkUserId: auth.clerkUserId,
        type: 'agent',
      };
      next();
    },
    autoProvision: (_req: any, _res: any, next: any) => next(),
    invalidateProvisionCache: () => {},
    resolveClerkIds: () => ({}),
  };
});

vi.mock('../../middleware/super-admin.middleware', () => ({
  requireSuperAdmin: (req: any, res: any, next: any) => {
    if (req.user?.role !== 'super_admin') {
      res.status(403).json({ error: 'Super admin access required' });
      return;
    }
    next();
  },
  resolveTenantContext: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

const auditSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/audit', () => ({ logAudit: (...a: unknown[]) => auditSpy(...a) }));

import request from 'supertest';
import { app } from '../../server';
import { createTestTenant, createTestUser } from '../helpers/factories';
import type { FeatureOverride } from '../../database/entities/Tenant';

const reason = (r = 'comp for launch') => r;
const ov = (value: boolean): FeatureOverride => ({
  value,
  reason: 'seed',
  setBy: 'admin@test',
  setAt: '2026-08-14T00:00:00Z',
});

async function asSuperAdmin(tenantId: string) {
  const admin = await createTestUser(tenantId, { role: 'admin' });
  auth.userId = admin.id;
  auth.tenantId = tenantId;
  auth.role = 'super_admin';
}

function put(tenantId: string, body: unknown) {
  return request(app).put(`/api/v1/admin/tenants/${tenantId}/feature-overrides`).send(body as object);
}

describe('PUT feature-overrides — above-tier confirmation guard', () => {
  it('rejects a NEW above-plan grant (bookings on Essential) without confirmation', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    await asSuperAdmin(tenant.id);

    const res = await put(tenant.id, { overrides: { bookings: { value: true, reason: reason() } } });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('above_tier_confirmation_required');
    expect(res.body.error?.details?.featureKeys).toEqual(['bookings']);
  });

  it('accepts the same grant once confirmAboveTier is sent', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    await asSuperAdmin(tenant.id);

    const res = await put(tenant.id, {
      overrides: { bookings: { value: true, reason: reason() } },
      confirmAboveTier: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.overrides.bookings.value).toBe(true);
  });

  it('legacy bare-map body is still guarded for a new above-tier grant', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    await asSuperAdmin(tenant.id);

    // Old portal shape: the feature map at the top level, no wrapper.
    const res = await put(tenant.id, { bookings: { value: true, reason: reason() } });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('above_tier_confirmation_required');
  });

  it('does NOT re-prompt when an unrelated setting changes and an existing comp is untouched', async () => {
    const tenant = await createTestTenant({
      tier: 'essential',
      featureOverrides: { bookings: ov(true) },
    });
    await asSuperAdmin(tenant.id);

    // Keep the existing bookings comp AND change an unrelated in-plan feature. No confirm.
    const res = await put(tenant.id, {
      overrides: {
        bookings: { value: true, reason: 'seed' },
        customWidgetAppearance: { value: false, reason: 'turn off for this tenant' },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.overrides.bookings.value).toBe(true);
    expect(res.body.data.overrides.customWidgetAppearance.value).toBe(false);
  });

  it('does NOT trip on an in-plan override (travelTime on Pro is a tier default)', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await asSuperAdmin(tenant.id);

    const res = await put(tenant.id, {
      overrides: { travelTime: { value: true, reason: 'enable travel' } },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.overrides.travelTime.value).toBe(true);
  });
});
