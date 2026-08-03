/**
 * The company-lookup endpoint.
 *
 * It proxies a European Commission service, so the properties that matter are about
 * restraint and about failure: it must not become an open scraper just because the
 * caller signed in, and none of the register's bad days may surface as an error the
 * customer has to solve.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const auth = vi.hoisted(() => ({ userId: '', tenantId: '', role: 'admin' }));

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: any, _res: any, next: any) => {
    req.userId = auth.userId;
    req.tenantId = auth.tenantId;
    req.user = { id: auth.userId, email: 'a@b.com', role: auth.role, tenantId: auth.tenantId };
    next();
  },
  autoProvision: (_req: any, _res: any, next: any) => next(),
  invalidateProvisionCache: () => {},
  resolveClerkIds: () => ({}),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(), emitToTenantAgents: vi.fn(), emitToAgent: vi.fn(),
}));

/** No real VIES calls in CI — the parsing is proven against the live register elsewhere. */
const lookup = vi.hoisted(() => vi.fn());
vi.mock('../../integrations/company-lookup/company-lookup.service', () => ({
  lookupCompanyByVat: lookup,
}));

/** Redis absent ⇒ the budget fails open, which is the documented behaviour. */
const redis = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../../config/redis', () => ({ getRedisClient: () => redis.client }));

import request from 'supertest';
import { app } from '../../server';
import { createTestTenant, createTestUser } from '../helpers/factories';

beforeEach(async () => {
  lookup.mockReset();
  redis.client = null;
  const tenant = await createTestTenant({ tier: 'free' });
  const user = await createTestUser(tenant.id, { role: 'admin' });
  Object.assign(auth, { userId: user.id, tenantId: tenant.id });
});

describe('GET /onboarding/company-lookup', () => {
  it('returns the company for a valid number', async () => {
    lookup.mockResolvedValue({
      status: 'found',
      cached: false,
      company: { vatNumber: 'BE0400378485', name: 'Colruyt Group', legalForm: 'NV', city: 'Halle' },
    });
    const res = await request(app).get('/api/v1/onboarding/company-lookup?vat=BE0400378485');
    expect(res.status).toBe(200);
    expect(res.body.data.company.name).toBe('Colruyt Group');
  });

  it('reports an unrecognised number as an answer, not an error', async () => {
    // `not_found` is a real fact about a real number — the customer has not done
    // anything wrong and must not be shown a failure to solve.
    lookup.mockResolvedValue({ status: 'not_found', company: null, cached: false });
    const res = await request(app).get('/api/v1/onboarding/company-lookup?vat=0999999999');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('not_found');
  });

  it('reports a register outage as 200/unavailable so signup can continue', async () => {
    // The product rule: losing a signup to someone else's downtime is far worse than
    // an unverified company record.
    lookup.mockResolvedValue({ status: 'unavailable', company: null, cached: false });
    const res = await request(app).get('/api/v1/onboarding/company-lookup?vat=0400378485');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('unavailable');
  });

  it('refuses to become an open proxy once the hourly budget is spent', async () => {
    // Repeats are free (the service caches, including negatives), so this only bites on
    // a loop over invented numbers — which is exactly the case worth stopping.
    let n = 0;
    redis.client = {
      multi: () => ({ incr: () => ({ expire: () => ({ exec: async () => [[null, ++n]]}) }) }),
    };
    lookup.mockResolvedValue({ status: 'not_found', company: null, cached: false });

    for (let i = 0; i < 30; i++) {
      const ok = await request(app).get(`/api/v1/onboarding/company-lookup?vat=010000000${i % 10}`);
      expect(ok.status).toBe(200);
    }
    const blocked = await request(app).get('/api/v1/onboarding/company-lookup?vat=0400378485');
    expect(blocked.status).toBe(429);
  });

  it('keeps working when Redis is down rather than blocking signup', async () => {
    redis.client = { multi: () => { throw new Error('redis down'); } };
    lookup.mockResolvedValue({ status: 'found', company: { name: 'X' }, cached: false });
    const res = await request(app).get('/api/v1/onboarding/company-lookup?vat=0400378485');
    expect(res.status).toBe(200);
  });
});
