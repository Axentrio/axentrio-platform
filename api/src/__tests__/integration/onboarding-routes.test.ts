/**
 * Onboarding routes.
 *
 * Onboarding cannot be skipped, which makes these three endpoints the only thing standing
 * between a new customer and the product. Two failure modes are worth more than the rest:
 *
 *   LOCKED OUT — a tenant who has been running for months gets sent through setup, or a
 *                required step refuses to accept a legitimate answer.
 *   LET THROUGH — a client posts its way past a required step, and a workspace reaches
 *                the product with no knowledge documents and no plan.
 *
 * The wizard is not the guard, so everything the wizard is supposed to prevent is asserted
 * against the HTTP surface directly.
 *
 * Mirrors the auth-mocking + bootstrap pattern of entitlements-routes.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const auth = vi.hoisted(() => ({
  userId: '',
  tenantId: '',
  role: 'admin' as string,
}));

const logAudit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

/**
 * VIES is a live government register measured at 3-8 seconds. Stubbed so the suite
 * neither depends on it being up nor spends seconds per assertion.
 */
const lookupCompanyByVat = vi.hoisted(() => vi.fn());

vi.mock('../../middleware/clerk.middleware', async () => {
  const { UnauthorizedError } = await import('../../middleware/error-handler');
  return {
    requireClerkAuth: (req: any, _res: any, next: any) => {
      if (!auth.userId) return next(new UnauthorizedError('Unauthorized'));
      req.userId = auth.userId;
      req.tenantId = auth.tenantId;
      req.userRole = auth.role;
      req.user = { id: auth.userId, role: auth.role, tenantId: auth.tenantId, type: 'agent' };
      next();
    },
    autoProvision: (_req: any, _res: any, next: any) => next(),
    invalidateProvisionCache: () => {},
    resolveClerkIds: () => ({}),
  };
});

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../utils/audit', () => ({ logAudit }));

vi.mock('../../integrations/company-lookup/company-lookup.service', () => ({
  lookupCompanyByVat,
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { createTestTenant, createTestUser, createTestAnchorBot } from '../helpers/factories';
import { Bot } from '../../database/entities/Bot';
import { KnowledgeBase } from '../../database/entities/KnowledgeBase';
import { KnowledgeDocument } from '../../database/entities/KnowledgeDocument';
import { ONBOARDING_STEPS, type OnboardingState } from '../../onboarding/onboarding-state';

const FOUND = {
  status: 'found',
  cached: false,
  company: { vatNumber: 'BE0400378485', name: 'Colruyt Group', countryCode: 'BE' },
};

async function signedInTenant(overrides: Partial<Tenant> = {}) {
  const tenant = await createTestTenant({ tier: 'pro', ...overrides });
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  auth.userId = admin.id;
  auth.tenantId = tenant.id;
  auth.role = 'admin';
  return tenant;
}

const reload = (id: string) =>
  AppDataSource.getRepository(Tenant).findOneOrFail({ where: { id } });

const storedState = async (id: string) =>
  ((await reload(id)).settings as { onboarding?: OnboardingState }).onboarding!;

/** The `documents` step is only accepted once the workspace really has one. */
async function giveTenantADocument(tenantId: string) {
  const kbRepo = AppDataSource.getRepository(KnowledgeBase);
  const kb = await kbRepo.save(kbRepo.create({ tenantId, botId: null }));
  const docRepo = AppDataSource.getRepository(KnowledgeDocument);
  await docRepo.save(
    docRepo.create({
      tenantId,
      knowledgeBaseId: kb.id,
      type: 'text',
      title: 'Opening hours',
      sourceContent: 'We are open 9-5.',
    }),
  );
}

/** Answer every step, in order, so `complete` becomes reachable. */
async function answerAllSteps(tenantId: string) {
  await giveTenantADocument(tenantId);
  for (const step of ONBOARDING_STEPS) {
    const body: Record<string, unknown> = { step, outcome: 'done' };
    if (step === 'language') body.language = 'nl';
    if (step === 'company') body.company = { vatNumber: 'BE0400378485', name: 'Colruyt Group' };
    const res = await request(app).put('/api/v1/onboarding/step').send(body);
    expect(res.status, `step ${step}: ${JSON.stringify(res.body)}`).toBe(200);
  }
}

beforeEach(() => {
  logAudit.mockClear();
  lookupCompanyByVat.mockReset().mockResolvedValue(FOUND);
});

describe('GET /onboarding/status', () => {
  it('sends a brand-new workspace to the first step', async () => {
    await signedInTenant();
    const res = await request(app).get('/api/v1/onboarding/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ nextStep: 'language', complete: false });
  });

  it('treats a grandfathered tenant as finished', async () => {
    // The whole point of the migration: nobody who has been using the product for
    // months may be trapped in a setup wizard on their next login.
    await signedInTenant({
      settings: {
        onboarding: { version: 1, grandfathered: true, completedAt: '2026-01-01T00:00:00.000Z', steps: {} },
      } as never,
    });
    const res = await request(app).get('/api/v1/onboarding/status');
    expect(res.body.data).toMatchObject({ complete: true, nextStep: null });
  });

  it('is readable by a non-admin, so the routing guard works for every member', async () => {
    // A 403 here reads as "unknown" to the guard, and the safe reading of unknown is
    // "send them to setup" — which would trap an agent in a wizard they cannot finish.
    const tenant = await signedInTenant();
    const agent = await createTestUser(tenant.id, { role: 'agent' });
    auth.userId = agent.id;
    auth.role = 'agent';

    const res = await request(app).get('/api/v1/onboarding/status');
    expect(res.status).toBe(200);
  });

  it('401s when signed out', async () => {
    auth.userId = '';
    expect((await request(app).get('/api/v1/onboarding/status')).status).toBe(401);
  });
});

describe('PUT /onboarding/step', () => {
  it('records an answer and advances to the next step', async () => {
    const tenant = await signedInTenant();
    const res = await request(app)
      .put('/api/v1/onboarding/step')
      .send({ step: 'language', outcome: 'done', language: 'fr' });

    expect(res.status).toBe(200);
    expect(res.body.data.nextStep).toBe('company');
    expect((await storedState(tenant.id)).language).toBe('fr');
  });

  it('refuses a skip on a required step', async () => {
    // A workspace with no knowledge document has a bot that cannot answer anything.
    await signedInTenant();
    const res = await request(app)
      .put('/api/v1/onboarding/step')
      .send({ step: 'documents', outcome: 'skipped' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/cannot be skipped/i);
  });

  it('rejects a step name it does not know', async () => {
    await signedInTenant();
    const res = await request(app)
      .put('/api/v1/onboarding/step')
      .send({ step: 'wire-me-money', outcome: 'done' });
    expect(res.status).toBe(400);
  });

  it('rejects an unsupported language rather than storing it', async () => {
    const tenant = await signedInTenant();
    const res = await request(app)
      .put('/api/v1/onboarding/step')
      .send({ step: 'language', outcome: 'done', language: 'kl' });

    expect(res.status).toBe(400);
    expect((await reload(tenant.id)).settings.onboarding).toBeUndefined();
  });

  it('requires the company step to actually carry a company', async () => {
    await signedInTenant();
    const res = await request(app)
      .put('/api/v1/onboarding/step')
      .send({ step: 'company', outcome: 'done' });
    expect(res.status).toBe(400);
  });

  it('persists company identity and registered address on the tenant', async () => {
    const tenant = await signedInTenant();
    const res = await request(app)
      .put('/api/v1/onboarding/step')
      .send({
        step: 'company',
        outcome: 'done',
        company: {
          vatNumber: 'BE0400378485',
          name: 'Colruyt Group',
          legalForm: 'NV',
          street: 'Edingensesteenweg 196',
          postalCode: '1500',
          city: 'Halle',
        },
      });

    expect(res.status).toBe(200);
    expect(await reload(tenant.id)).toMatchObject({
      officialBusinessName: 'Colruyt Group',
      vatNumber: 'BE0400378485',
      vatVerified: true,
      invoiceAddress: {
        street: 'Edingensesteenweg 196',
        postalCode: '1500',
        city: 'Halle',
        country: 'BE',
      },
    });
  });

  it('decides `verified` from the register, never from the client', async () => {
    // Otherwise "this company was confirmed by the register" means nothing: anyone
    // could post verified:true with an invented number.
    const tenant = await signedInTenant();
    lookupCompanyByVat.mockResolvedValue({ status: 'not_found', company: null, cached: false });

    await request(app)
      .put('/api/v1/onboarding/step')
      .send({
        step: 'company',
        outcome: 'done',
        company: { vatNumber: 'BE0999999999', name: 'Definitely Real BV', verified: true },
      });

    expect((await storedState(tenant.id)).company?.verified).toBe(false);
  });

  it('still accepts the company when the register is down', async () => {
    // Losing a signup to someone else's downtime is far worse than an unverified record.
    const tenant = await signedInTenant();
    lookupCompanyByVat.mockResolvedValue({ status: 'unavailable', company: null, cached: false });

    const res = await request(app)
      .put('/api/v1/onboarding/step')
      .send({
        step: 'company',
        outcome: 'done',
        company: { vatNumber: 'BE0400378485', name: 'Typed By Hand BV' },
      });

    expect(res.status).toBe(200);
    const state = await storedState(tenant.id);
    expect(state.company).toMatchObject({ name: 'Typed By Hand BV', verified: false });
  });

  it('#153: a physical presence activates the per-bot quoted-address field', async () => {
    const tenant = await signedInTenant();
    await createTestAnchorBot(tenant);
    const res = await request(app)
      .put('/api/v1/onboarding/step')
      .send({
        step: 'company',
        outcome: 'done',
        company: { vatNumber: 'BE0400378485', name: 'Shop BV', presence: 'physical' },
      });
    expect(res.status).toBe(200);
    expect((await storedState(tenant.id)).company?.presence).toBe('physical');
    const bot = await AppDataSource.getRepository(Bot).findOneByOrFail({ tenantId: tenant.id, isDefault: true });
    expect(bot.settings?.quotedAddress?.enabled).toBe(true);
  });

  it('#153: an online presence defaults the per-bot address on', async () => {
    const tenant = await signedInTenant();
    await createTestAnchorBot(tenant);
    await request(app)
      .put('/api/v1/onboarding/step')
      .send({
        step: 'company',
        outcome: 'done',
        company: { vatNumber: 'BE0400378485', name: 'Webshop BV', presence: 'online' },
      });
    const bot = await AppDataSource.getRepository(Bot).findOneByOrFail({ tenantId: tenant.id, isDefault: true });
    expect(bot.settings?.quotedAddress?.enabled).toBe(true);
  });

  it('#153: resubmitting company details preserves an explicitly disabled address', async () => {
    const tenant = await signedInTenant();
    await createTestAnchorBot(tenant, {
      settings: { quotedAddress: { enabled: false } } as Bot['settings'],
    });

    const res = await request(app)
      .put('/api/v1/onboarding/step')
      .send({
        step: 'company',
        outcome: 'done',
        company: { vatNumber: 'BE0400378485', name: 'Webshop BV', presence: 'online' },
      });

    expect(res.status).toBe(200);
    const bot = await AppDataSource.getRepository(Bot).findOneByOrFail({ tenantId: tenant.id, isDefault: true });
    expect(bot.settings?.quotedAddress?.enabled).toBe(false);
  });

  it('is admin-only', async () => {
    const tenant = await signedInTenant();
    const agent = await createTestUser(tenant.id, { role: 'agent' });
    auth.userId = agent.id;
    auth.role = 'agent';

    const res = await request(app)
      .put('/api/v1/onboarding/step')
      .send({ step: 'language', outcome: 'done', language: 'nl' });
    expect(res.status).toBe(403);
  });

  it('does not clobber the other things living in tenant settings', async () => {
    // `settings` is shared with the theme, widget and business-hours writers. A
    // read-modify-write from here would silently drop whatever they had just changed.
    const tenant = await signedInTenant({ settings: { theme: { primary: '#123456' } } as never });

    await request(app)
      .put('/api/v1/onboarding/step')
      .send({ step: 'language', outcome: 'done', language: 'nl' });

    const settings = (await reload(tenant.id)).settings as Record<string, unknown>;
    expect(settings.theme).toEqual({ primary: '#123456' });
    expect(settings.onboarding).toBeDefined();
  });
});

describe('PATCH /tenants/me/ai-settings', () => {
  it('persists the onboarding trading name on the anchor bot', async () => {
    const tenant = await signedInTenant();
    const anchor = await createTestAnchorBot(tenant);

    const res = await request(app)
      .patch('/api/v1/tenants/me/ai-settings')
      .send({
        brandVoice: {
          name: 'Sofie',
          businessName: 'Acme Services',
          tone: 'friendly',
        },
      });

    expect(res.status).toBe(200);
    const bot = await AppDataSource.getRepository(Bot).findOneByOrFail({ id: anchor.id });
    expect(bot.settings.ai?.brandVoice).toMatchObject({
      name: 'Sofie',
      businessName: 'Acme Services',
      tone: 'friendly',
    });
  });
});

describe('PUT /onboarding/step — skipping switches the feature off', () => {
  it('turns bookings off when the customer says not now', async () => {
    // "Not now" during setup and "off" in Settings are one decision. A tenant who
    // declined bookings must not find a booking surface quietly waiting for them.
    const tenant = await signedInTenant();
    await request(app).put('/api/v1/onboarding/step').send({ step: 'bookings', outcome: 'skipped' });

    expect((await reload(tenant.id)).featureToggles).toMatchObject({ bookings: false });
  });

  it('turns every social channel off in one answer', async () => {
    const tenant = await signedInTenant();
    await request(app).put('/api/v1/onboarding/step').send({ step: 'social', outcome: 'skipped' });

    expect((await reload(tenant.id)).featureToggles).toMatchObject({
      channelWhatsapp: false,
      channelMessenger: false,
      channelInstagram: false,
      channelTelegram: false,
      channelLinkedin: false,
      channelTiktok: false,
      channelX: false,
    });
  });

  it('switches the website assistant off when the chatbot step is skipped', async () => {
    // The one skip that is not a feature toggle: `ai.enabled` on the anchor bot. A
    // customer who said "not now" to a chatbot must not have one answering visitors.
    const tenant = await signedInTenant();
    const botRepo = AppDataSource.getRepository(Bot);
    await botRepo.save(
      botRepo.create({
        tenantId: tenant.id,
        name: 'Anchor',
        publicKey: tenant.apiKey,
        isDefault: true,
        settings: { ai: { enabled: true } } as never,
      }),
    );

    await request(app).put('/api/v1/onboarding/step').send({ step: 'chatbot', outcome: 'skipped' });

    const bot = await botRepo.findOneOrFail({ where: { tenantId: tenant.id, isDefault: true } });
    expect((bot.settings as { ai?: { enabled?: boolean } }).ai?.enabled).toBe(false);
  });

  it('leaves toggles alone when the step is answered rather than skipped', async () => {
    // Saying yes is intent, not entitlement. Writing `true` here could exceed the
    // tenant's plan, which the feature-toggles route explicitly refuses.
    const tenant = await signedInTenant();
    await request(app).put('/api/v1/onboarding/step').send({ step: 'bookings', outcome: 'done' });

    expect((await reload(tenant.id)).featureToggles ?? {}).not.toHaveProperty('bookings');
  });

  it('preserves toggles it was not asked about', async () => {
    const tenant = await signedInTenant({ featureToggles: { leadCapture: true } as never });
    await request(app).put('/api/v1/onboarding/step').send({ step: 'bookings', outcome: 'skipped' });

    expect((await reload(tenant.id)).featureToggles).toMatchObject({
      leadCapture: true,
      bookings: false,
    });
  });
});

describe('POST /onboarding/complete', () => {
  it('refuses while a step is still outstanding, and says which', async () => {
    await signedInTenant();
    await request(app)
      .put('/api/v1/onboarding/step')
      .send({ step: 'language', outcome: 'done', language: 'nl' });

    const res = await request(app).post('/api/v1/onboarding/complete');
    expect(res.status).toBe(409);
    expect(res.body.error.details.nextStep).toBe('company');
  });

  it('completes once every step is answered, and records it', async () => {
    const tenant = await signedInTenant();
    await answerAllSteps(tenant.id);

    const res = await request(app).post('/api/v1/onboarding/complete');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ complete: true, nextStep: null });
    expect((await storedState(tenant.id)).completedAt).toBeTruthy();
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      'tenant.onboarding_completed',
      'tenant',
      tenant.id,
      tenant.id,
      expect.objectContaining({ companyVerified: true }),
    );
  });

  it('stops sending the tenant to setup once finished', async () => {
    const tenant = await signedInTenant();
    await answerAllSteps(tenant.id);
    await request(app).post('/api/v1/onboarding/complete');

    const status = await request(app).get('/api/v1/onboarding/status');
    expect(status.body.data.complete).toBe(true);
  });

  it('keeps the original completion timestamp if called twice', async () => {
    const tenant = await signedInTenant();
    await answerAllSteps(tenant.id);
    await request(app).post('/api/v1/onboarding/complete');
    const first = (await storedState(tenant.id)).completedAt;

    await request(app).post('/api/v1/onboarding/complete');
    expect((await storedState(tenant.id)).completedAt).toBe(first);
  });

  it('is admin-only', async () => {
    const tenant = await signedInTenant();
    const agent = await createTestUser(tenant.id, { role: 'agent' });
    auth.userId = agent.id;
    auth.role = 'agent';

    expect((await request(app).post('/api/v1/onboarding/complete')).status).toBe(403);
  });
});

describe('PUT /onboarding/step — a required step needs the real thing, not a claim', () => {
  it('refuses `documents: done` from a workspace with no documents', async () => {
    // Otherwise the requirement is decorative: the wizard would simply post it and
    // move on, and the customer reaches the product with a bot that knows nothing.
    const tenant = await signedInTenant();
    const res = await request(app)
      .put('/api/v1/onboarding/step')
      .send({ step: 'documents', outcome: 'done' });

    expect(res.status).toBe(409);
    expect((await reload(tenant.id)).settings.onboarding?.steps.documents).toBeUndefined();
  });

  it('accepts it once a document exists', async () => {
    const tenant = await signedInTenant();
    await giveTenantADocument(tenant.id);

    const res = await request(app)
      .put('/api/v1/onboarding/step')
      .send({ step: 'documents', outcome: 'done' });
    expect(res.status).toBe(200);
  });
});
