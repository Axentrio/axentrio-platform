/**
 * The on-demand analysis endpoint, against a real database.
 *
 * The properties worth pinning are the ones that cost money or trust when wrong: the
 * cooldown is enforced SERVER-side (the button's view is always slightly stale), the
 * conversation counter agrees with what the judge would actually consume, and a tenant
 * whose analysis is automatic is never offered a manual run that would duplicate it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const auth = vi.hoisted(() => ({ userId: '', tenantId: '', role: 'admin' }));

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/clerk.middleware', () => ({
  requireClerkAuth: (req: any, _res: any, next: any) => {
    req.userId = auth.userId;
    req.tenantId = auth.tenantId;
    req.userRole = auth.role;
    req.user = { id: auth.userId, email: 't@example.com', role: auth.role, tenantId: auth.tenantId };
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

/** The analysis itself is an LLM pass; this suite is about the gate around it. */
const refreshed = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../insights/refresh-insights.job', () => ({
  refreshTenantInsights: async (tenantId: string) => {
    refreshed.calls.push(tenantId);
  },
  registerInsightsRefreshJob: () => {},
  runRefreshInsightsOnce: async () => {},
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { InsightsRefreshState } from '../../database/entities/InsightsRefreshState';
import { createTestTenant, createTestUser, createTestBillingAccount, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

let tenantId: string;
let botId: string;

async function seedTenant(tier: 'essential' | 'pro' | 'enterprise') {
  const tenant = await createTestTenant({ tier });
  tenantId = tenant.id;
  await createTestBillingAccount(tenantId, { status: 'active', currentPlanId: tier });
  const bot = await createTestAnchorBot(tenant as Tenant);
  botId = bot.id;
  const user = await createTestUser(tenantId, { role: 'admin' });
  Object.assign(auth, { userId: user.id, tenantId, role: 'admin' });
}

/**
 * Sessions shaped exactly as the judge selects them. `guardrailStatus` matters: a
 * spam-flagged conversation is excluded from insights, so counting it would unlock the
 * button on data the analysis then refuses to look at.
 */
async function seedSessions(n: number, over: Partial<ChatSession> = {}) {
  const repo = AppDataSource.getRepository(ChatSession);
  for (let i = 0; i < n; i++) {
    await repo.save(
      repo.create({
        tenantId,
        botId,
        visitorId: `v-${Math.random().toString(36).slice(2, 10)}`,
        status: 'closed',
        guardrailStatus: 'normal',
        startedAt: new Date(Date.now() - 3_600_000),
        lastActivityAt: new Date(),
        endedAt: new Date(),
        ...over,
      }),
    );
  }
}

beforeEach(() => {
  refreshed.calls = [];
});

describe('GET /insights/analysis-status', () => {
  it('counts only the conversations the judge would actually consume', async () => {
    await seedTenant('pro');
    await seedSessions(5);
    await seedSessions(4, { status: 'active' }); // never judged — still open
    await seedSessions(3, { guardrailStatus: 'spam' }); // excluded from insights

    const res = await request(app).get('/api/v1/insights/analysis-status');
    expect(res.status).toBe(200);
    expect(res.body.data.newChats).toBe(5);
    expect(res.body.data.minNewChats).toBe(8);
    expect(res.body.data.reason).toBe('not_enough_chats');
  });

  it('tells Enterprise that analysis is automatic rather than offering a button', async () => {
    await seedTenant('enterprise');
    await seedSessions(50);
    const res = await request(app).get('/api/v1/insights/analysis-status');
    expect(res.body.data.eligible).toBe(false);
    expect(res.body.data.reason).toBe('automatic');
    expect(res.body.data.policy.automatic).toBe(true);
  });
});

describe('POST /insights/analyse', () => {
  it('runs when the tier bar is met, and stamps the cooldown', async () => {
    await seedTenant('pro');
    await seedSessions(8);

    const res = await request(app).post('/api/v1/insights/analyse');
    expect(res.status).toBe(200);
    expect(refreshed.calls).toEqual([tenantId]);

    const state = await AppDataSource.getRepository(InsightsRefreshState).findOne({
      where: { tenantId },
    });
    expect(state?.lastManualRunAt).toBeTruthy();
  });

  it('refuses a second run inside the cooldown, with the numbers to explain it', async () => {
    await seedTenant('pro');
    await seedSessions(40);
    await request(app).post('/api/v1/insights/analyse');
    refreshed.calls = [];

    const res = await request(app).post('/api/v1/insights/analyse');
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('cooling_down');
    expect(res.body.error.details.nextAllowedAt).toBeTruthy();
    // The refusal is what matters: no LLM pass was started.
    expect(refreshed.calls).toEqual([]);
  });

  it('refuses below the minimum even though the client may have offered the button', async () => {
    // The client's view is seconds stale by definition, so the gate cannot live there.
    await seedTenant('essential');
    await seedSessions(14);
    const res = await request(app).post('/api/v1/insights/analyse');
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('not_enough_chats');
    expect(res.body.error.details.newChats).toBe(14);
    expect(res.body.error.details.minNewChats).toBe(15);
    expect(refreshed.calls).toEqual([]);
  });

  it('never lets an Enterprise tenant duplicate the automatic pass', async () => {
    await seedTenant('enterprise');
    await seedSessions(50);
    const res = await request(app).post('/api/v1/insights/analyse');
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('automatic');
    expect(refreshed.calls).toEqual([]);
  });
});
