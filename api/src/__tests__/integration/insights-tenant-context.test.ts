/**
 * Super-admin tenant switching on the insights router.
 *
 * `resolveTenantContext` has always been mounted on this router, but every route read
 * `user.tenantId` directly and never `req.tenantId` — so the header was ignored and the
 * middleware was decorative. A super admin who switched to another workspace was shown
 * their OWN insights while the switcher said otherwise, and the Enterprise-only panels
 * 403'd on a tenant that was genuinely entitled. Found on production: the lead-demand
 * panel returned 403 for an enterprise tenant because the caller's own tenant was Pro.
 *
 * Both directions matter, so both are asserted here: the header must be HONOURED for a
 * super admin, and must remain INERT for everyone else. The second test is the one that
 * keeps the fix from becoming a cross-tenant read.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Deliberately NOT `createAuthMocks()`: that helper stubs `resolveTenantContext` to a
 * plain `next()` (helpers/auth.ts), which is exactly the middleware under test here — a
 * test built on it would pass no matter what the real one does. Only authentication is
 * mocked below; the real super-admin middleware runs against the test database.
 */
const auth = vi.hoisted(() => ({ userId: '', tenantId: '', role: 'admin' }));

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: any, _res: any, next: any) => {
    req.userId = auth.userId;
    req.tenantId = auth.tenantId; // caller's own tenant; the middleware may override it
    req.userRole = auth.role;
    req.user = { id: auth.userId, email: 'test@example.com', role: auth.role, tenantId: auth.tenantId };
    next();
  },
  autoProvision: (_req: any, _res: any, next: any) => next(),
  invalidateProvisionCache: () => {},
  resolveClerkIds: () => ({}),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { createTestTenant, createTestUser, createTestBillingAccount } from '../helpers/factories';

/** The caller's own workspace (Pro — NOT entitled to aiBusinessInsights). */
let ownTenantId: string;
/** The workspace being switched INTO (Enterprise — entitled). */
let targetTenantId: string;

const SEEDED_TARGET_LEADS = 3;

async function seedLeads(tenantId: string, n: number) {
  const repo = AppDataSource.getRepository(Lead);
  for (let i = 0; i < n; i++) {
    const s = `${tenantId.slice(0, 8)}-${i}`;
    await repo.save(
      repo.create({
        tenantId,
        email: `demand-${s}@example.com`,
        dedupeKey: `email:demand-${s}@example.com`,
        source: 'tool',
      }),
    );
  }
}

beforeEach(async () => {
  const own = await createTestTenant({ tier: 'pro' });
  ownTenantId = own.id;
  await createTestBillingAccount(ownTenantId, { status: 'active', currentPlanId: 'pro' });

  const target = await createTestTenant({ tier: 'enterprise' });
  targetTenantId = target.id;
  await createTestBillingAccount(targetTenantId, { status: 'active', currentPlanId: 'enterprise' });

  // Only the TARGET has leads, so the denominator in the response identifies which
  // tenant was actually read — a 200 alone would not.
  await seedLeads(targetTenantId, SEEDED_TARGET_LEADS);
});

describe('insights router — X-Tenant-Context', () => {
  it('a SUPER ADMIN reads the target tenant, not their own', async () => {
    const user = await createTestUser(ownTenantId, { role: 'super_admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'super_admin' });

    const res = await request(app)
      .get('/api/v1/insights/lead-demand')
      .set('x-tenant-context', targetTenantId);

    // Before the fix this was 403: the gate read the caller's Pro tenant.
    expect(res.status).toBe(200);
    // And the payload is the TARGET's data, not the caller's (which has no leads).
    expect(res.body.data.totalLeads).toBe(SEEDED_TARGET_LEADS);
  });

  it('a NON-super-admin cannot use the header to read another tenant', async () => {
    const user = await createTestUser(ownTenantId, { role: 'admin' });
    Object.assign(auth, { userId: user.id, tenantId: ownTenantId, role: 'admin' });

    const res = await request(app)
      .get('/api/v1/insights/lead-demand')
      .set('x-tenant-context', targetTenantId);

    // Header inert: still bound to the caller's Pro tenant, which lacks the feature.
    expect(res.status).toBe(403);
    expect(res.body.error?.details?.feature).toBe('aiBusinessInsights');
  });
});
