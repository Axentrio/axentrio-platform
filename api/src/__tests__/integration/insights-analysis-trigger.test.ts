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
const refreshed = vi.hoisted(() => ({
  calls: [] as string[],
  /** Held open so a test can observe the run while it is still in flight. */
  gate: null as null | (() => void),
  shouldThrow: false,
}));
vi.mock('../../insights/refresh-insights.job', () => ({
  refreshTenantInsights: async (tenantId: string) => {
    refreshed.calls.push(tenantId);
    if (refreshed.gate) await new Promise<void>((r) => { refreshed.gate = r; });
    if (refreshed.shouldThrow) throw new Error('judge exploded');
  },
  registerInsightsRefreshJob: () => {},
  runRefreshInsightsOnce: async () => {},
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { InsightsRefreshState } from '../../database/entities/InsightsRefreshState';
import { SpamScamLog } from '../../database/entities/SpamScamLog';
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
  const sessions: ChatSession[] = [];
  for (let i = 0; i < n; i++) {
    sessions.push(await repo.save(
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
    ));
  }
  return sessions;
}

beforeEach(() => {
  refreshed.calls = [];
  refreshed.gate = null;
  refreshed.shouldThrow = false;
});

/**
 * The route answers 202 before the pass finishes, so these tests wait for a CONDITION,
 * never for a guessed delay. A fixed 20ms sleep here made this file fail under parallel
 * load: the claim had sometimes not cleared yet, so the next request read `running`
 * where the test wanted `cooling_down`, and the failure pointed at an assertion instead
 * of at the race.
 *
 * The poll below uses a REAL short delay on purpose. Fake timers cannot help: the state
 * being awaited is a row written by a detached promise inside the route, so the only
 * signal available to the test is the database itself.
 */
async function waitFor(label: string, ready: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (await ready()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    // Executor form, not Promise.withResolvers: this package's `lib` target predates it.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The pass has finished and released its claim. */
const settle = () =>
  waitFor('the analysis claim to clear', async () => {
    const state = await AppDataSource.getRepository(InsightsRefreshState).findOne({
      where: { tenantId },
    });
    return state == null || state.analysisRunningSince == null;
  });

/** The pass has STARTED and is being held open by the gate. */
const settleStarted = () => waitFor('the analysis to start', () => refreshed.calls.length > 0);

describe('GET /insights/analysis-status', () => {
  it('excludes detection journals but keeps routing-isolation journals in the eligible count', async () => {
    await seedTenant('pro');
    await seedSessions(5);
    await seedSessions(4, { status: 'active' }); // never judged — still open
    await seedSessions(3, { guardrailStatus: 'spam' }); // enforce-mode exclusions
    const [shadowFlagged] = await seedSessions(1);
    const [enforceFlagged] = await seedSessions(1);
    const logRepo = AppDataSource.getRepository(SpamScamLog);
    await logRepo.save([
      logRepo.create({
        tenantId,
        conversationId: shadowFlagged.id,
        sourceChannel: 'widget',
        detectedCategory: 'spam',
        enforced: false,
      }),
      logRepo.create({
        tenantId,
        conversationId: enforceFlagged.id,
        sourceChannel: 'widget',
        detectedCategory: 'spam',
        enforced: true,
      }),
    ]);

    const afterDetections = await request(app).get('/api/v1/insights/analysis-status');
    expect(afterDetections.status).toBe(200);
    expect(afterDetections.body.data.newChats).toBe(5);

    const [missingTenant, missingBot] = await seedSessions(2);
    await logRepo.save([
      logRepo.create({
        tenantId,
        conversationId: missingTenant.id,
        sourceChannel: 'widget',
        detectedCategory: 'missing_tenant',
        enforced: true,
      }),
      logRepo.create({
        tenantId,
        conversationId: missingBot.id,
        sourceChannel: 'widget',
        detectedCategory: 'missing_bot',
        enforced: true,
      }),
    ]);

    const res = await request(app).get('/api/v1/insights/analysis-status');
    expect(res.status).toBe(200);
    expect(res.body.data.newChats).toBe(7);
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
  it('accepts the run without waiting for it, and stamps the cooldown', async () => {
    // 202, not 200: the pass is one LLM call per conversation and Essential cannot
    // unlock the button below fifteen of them, so awaiting it would blow the portal's
    // 30s timeout at the smallest run the gate even permits.
    await seedTenant('pro');
    await seedSessions(8);

    const res = await request(app).post('/api/v1/insights/analyse');
    expect(res.status).toBe(202);
    await settle();
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
    await settle();
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
    // 403, not 409: they are not in conflict with anything, they have no such control.
    expect(res.status).toBe(403);
    expect(res.body.error.details.reason).toBe('automatic');
    expect(refreshed.calls).toEqual([]);
  });

  it('reports the run as in flight while it is still going', async () => {
    await seedTenant('pro');
    await seedSessions(20);
    refreshed.gate = () => {}; // hold the analysis open

    await request(app).post('/api/v1/insights/analyse');
    await settleStarted();

    const status = await request(app).get('/api/v1/insights/analysis-status');
    expect(status.body.data.running).toBe(true);
    expect(status.body.data.reason).toBe('running');

    refreshed.gate?.(); // let it finish
    await settle();
    const after = await request(app).get('/api/v1/insights/analysis-status');
    expect(after.body.data.running).toBe(false);
  });

  it('releases the claim when the analysis throws, so the tenant is not stranded', async () => {
    // A dead lease helps nobody: without this the tenant sits on "analysing" until
    // someone edits the database.
    await seedTenant('pro');
    await seedSessions(20);
    refreshed.shouldThrow = true;

    await request(app).post('/api/v1/insights/analyse');
    await settle();

    const status = await request(app).get('/api/v1/insights/analysis-status');
    expect(status.body.data.running).toBe(false);
    // The cooldown still stands — the LLM calls were spent either way.
    expect(status.body.data.reason).toBe('cooling_down');
  });

  it('refuses a second start while one is in flight', async () => {
    await seedTenant('pro');
    await seedSessions(20);
    refreshed.gate = () => {};

    await request(app).post('/api/v1/insights/analyse');
    await settleStarted();
    refreshed.calls = [];

    const second = await request(app).post('/api/v1/insights/analyse');
    expect(second.status).toBe(409);
    expect(refreshed.calls).toEqual([]);

    refreshed.gate?.();
    await settle();
  });
});
