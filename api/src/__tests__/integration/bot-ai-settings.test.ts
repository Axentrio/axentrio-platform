/**
 * Integration tests for per-bot AI settings + test chat (multi-bot config editing).
 *
 * Covers the bot-scoped GET/PUT /bots/:id/ai-settings and POST /bots/:id/test-chat,
 * plus the shared-KB attachment on bot creation. The LLM layer is partially
 * mocked (generateResponse + provider-factory) so test chat is deterministic.
 */
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

const { mockGenerateResponse, mockChat } = vi.hoisted(() => ({
  mockGenerateResponse: vi.fn(),
  mockChat: vi.fn(),
}));

// Keep all real exports; override only the two LLM entry points.
vi.mock('../../llm/rag.service', async (importActual) => ({
  ...(await importActual<typeof import('../../llm/rag.service')>()),
  generateResponse: mockGenerateResponse,
}));

vi.mock('../../llm/provider-factory', async (importActual) => ({
  ...(await importActual<typeof import('../../llm/provider-factory')>()),
  getProvider: () => ({ chat: mockChat }),
}));

import request from 'supertest';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { Bot } from '../../database/entities/Bot';
import { KnowledgeBase } from '../../database/entities/KnowledgeBase';
import { BotKnowledgeBase } from '../../database/entities/BotKnowledgeBase';
import { app } from '../../server';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { computeSlots } from '../../booking/booking-providers/slot-engine';
import { createTestTenant, createTestAnchorBot, createTestUser } from '../helpers/factories';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../../llm/defaults';

const fullAiBody = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  supportEmail: 'help@acme.com',
  brandVoice: { name: 'Acme Bot', tone: 'professional', customInstructions: 'Be concise.', templateId: null },
  guardrails: {
    topicsToAvoid: [],
    escalationKeywords: ['human'],
    confidenceThreshold: 0.6,
    maxResponseLength: 400,
    greetingMessage: 'Hi',
    fallbackMessage: 'Let me connect you.',
    offHoursMessage: 'Closed.',
  },
  ...over,
});

async function attachKb(tenantId: string, botId: string): Promise<string> {
  const kb = await AppDataSource.getRepository(KnowledgeBase).save(
    AppDataSource.getRepository(KnowledgeBase).create({ tenantId, botId: null, status: 'inactive' }),
  );
  await AppDataSource.getRepository(BotKnowledgeBase).save(
    AppDataSource.getRepository(BotKnowledgeBase).create({ tenantId, botId, knowledgeBaseId: kb.id }),
  );
  return kb.id;
}

describe('Per-bot AI settings', () => {
  let tenantId: string;
  let botId: string;

  beforeEach(async () => {
    mockGenerateResponse.mockReset();
    mockChat.mockReset();
    const tenant = await createTestTenant({
      settings: { ai: { apiKey: 'sk-tenant-key' } } as Tenant['settings'],
    });
    tenantId = tenant.id;
    const bot = await createTestAnchorBot(tenant, {
      settings: {
        ai: {
          enabled: false,
          provider: 'anthropic',
          model: 'claude-x',
          brandVoice: { name: 'Existing', tone: 'friendly', customInstructions: '' },
          guardrails: {
            topicsToAvoid: [],
            escalationKeywords: [],
            confidenceThreshold: 0.7,
            maxResponseLength: 500,
            greetingMessage: 'hi',
            fallbackMessage: 'bye',
            offHoursMessage: 'off',
          },
        },
      } as Bot['settings'],
    });
    botId = bot.id;
    const admin = await createTestUser(tenantId, { role: 'admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'admin' });
  });

  describe('GET /bots/:id', () => {
    it('distinguishes an unsaved quoted address from one explicitly disabled', async () => {
      const unsaved = await request(app).get(`/api/v1/bots/${botId}`);
      expect(unsaved.status).toBe(200);
      expect(unsaved.body.data.quotedAddress).toBeUndefined();

      const update = await request(app)
        .patch(`/api/v1/bots/${botId}`)
        .send({ quotedAddress: { enabled: false } });
      expect(update.status).toBe(200);

      const disabled = await request(app).get(`/api/v1/bots/${botId}`);
      expect(disabled.body.data.quotedAddress).toMatchObject({ enabled: false });
    });
  });

  describe('GET /bots/:id/ai-settings', () => {
    it('returns the bot ai shape with hasApiKey and never leaks apiKey', async () => {
      const res = await request(app).get(`/api/v1/bots/${botId}/ai-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.brandVoice.name).toBe('Existing');
      expect(res.body.data.hasApiKey).toBe(true);
      expect(res.body.data.apiKey).toBeUndefined();
    });

    it('defaults language to English when the bot has no ai settings', async () => {
      const t = await createTestTenant();
      const b = await createTestAnchorBot(t, { settings: {} as Bot['settings'] });
      const u = await createTestUser(t.id, { role: 'admin' });
      configureMockAuth(auth, { userId: u.id, tenantId: t.id, role: 'admin' });

      const res = await request(app).get(`/api/v1/bots/${b.id}/ai-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.language).toBe('en');
    });

    it('fills a full default shape when the bot has no ai settings', async () => {
      const t = await createTestTenant();
      const b = await createTestAnchorBot(t, { settings: {} as Bot['settings'] });
      const u = await createTestUser(t.id, { role: 'admin' });
      configureMockAuth(auth, { userId: u.id, tenantId: t.id, role: 'admin' });

      const res = await request(app).get(`/api/v1/bots/${b.id}/ai-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);
      // The contract is "the API reports the platform default", not a specific
      // model name. A literal here drifts on every model swap: that is what
      // turned the gpt-5.6-luna change red in CI.
      expect(res.body.data.provider).toBe(DEFAULT_PROVIDER);
      expect(res.body.data.model).toBe(DEFAULT_MODEL);
      expect(res.body.data.brandVoice.templateId).toBeNull();
      expect(res.body.data.guardrails.confidenceThreshold).toBe(0.7);
      expect(res.body.data.hasApiKey).toBe(false);
    });

    it('404s for a bot owned by another tenant', async () => {
      const other = await createTestTenant();
      const otherBot = await createTestAnchorBot(other);
      // auth stays as the first tenant's admin
      const res = await request(app).get(`/api/v1/bots/${otherBot.id}/ai-settings`);
      expect(res.status).toBe(404);
    });

    it('allows supervisor to read', async () => {
      const sup = await createTestUser(tenantId, { role: 'supervisor' });
      configureMockAuth(auth, { userId: sup.id, tenantId, role: 'supervisor' });
      const res = await request(app).get(`/api/v1/bots/${botId}/ai-settings`);
      expect(res.status).toBe(200);
    });
  });

  describe('PUT /bots/:id/ai-settings', () => {
    it('full-replaces editable fields and preserves provider/model', async () => {
      const res = await request(app)
        .put(`/api/v1/bots/${botId}/ai-settings`)
        .send(fullAiBody({ brandVoice: { name: 'New Name', tone: 'casual', customInstructions: 'X', templateId: null } }));
      expect(res.status).toBe(200);

      const bot = await AppDataSource.getRepository(Bot).findOneOrFail({ where: { id: botId } });
      expect(bot.settings.ai?.brandVoice.name).toBe('New Name');
      expect(bot.settings.ai?.enabled).toBe(true);
      // Out-of-scope keys preserved from the pre-existing row.
      expect(bot.settings.ai?.provider).toBe('anthropic');
      expect(bot.settings.ai?.model).toBe('claude-x');
      // Never persisted onto the bot.
      expect((bot.settings.ai as Record<string, unknown>).apiKey).toBeUndefined();
    });

    it('persists a per-bot brandVoice.businessName when provided', async () => {
      const res = await request(app)
        .put(`/api/v1/bots/${botId}/ai-settings`)
        .send(fullAiBody({ brandVoice: { name: 'Acme Bot', tone: 'professional', customInstructions: '', businessName: '  GlowSpa  ' } }));
      expect(res.status).toBe(200);
      const bot = await AppDataSource.getRepository(Bot).findOneOrFail({ where: { id: botId } });
      // Trimmed on save.
      expect(bot.settings.ai?.brandVoice.businessName).toBe('GlowSpa');
    });

    it('omits brandVoice.businessName when blank (inherits the tenant business name)', async () => {
      const res = await request(app)
        .put(`/api/v1/bots/${botId}/ai-settings`)
        .send(fullAiBody({ brandVoice: { name: 'Acme Bot', tone: 'professional', customInstructions: '', businessName: '   ' } }));
      expect(res.status).toBe(200);
      const bot = await AppDataSource.getRepository(Bot).findOneOrFail({ where: { id: botId } });
      expect(bot.settings.ai?.brandVoice.businessName).toBeUndefined();
    });

    it('persists language and rewrites a stock greeting', async () => {
      const res = await request(app)
        .put(`/api/v1/bots/${botId}/ai-settings`)
        .send(fullAiBody({
          language: 'nl',
          guardrails: {
            topicsToAvoid: [],
            escalationKeywords: ['human'],
            confidenceThreshold: 0.6,
            maxResponseLength: 400,
            greetingMessage: 'Welcome! How can I help you today?',
            fallbackMessage: 'Let me connect you.',
            offHoursMessage: 'Closed.',
          },
        }));
      expect(res.status).toBe(200);
      expect(res.body.data.language).toBe('nl');
      expect(res.body.data.guardrails.greetingMessage).toBe('Welkom! Waarmee kan ik je helpen?');
      const bot = await AppDataSource.getRepository(Bot).findOneOrFail({ where: { id: botId } });
      expect(bot.settings.ai?.language).toBe('nl');
      expect(bot.settings.ai?.guardrails.greetingMessage).toBe('Welkom! Waarmee kan ik je helpen?');
    });

    it('keeps a custom greeting when language changes', async () => {
      const res = await request(app)
        .put(`/api/v1/bots/${botId}/ai-settings`)
        .send(fullAiBody({
          language: 'fr',
          guardrails: {
            topicsToAvoid: [],
            escalationKeywords: ['human'],
            confidenceThreshold: 0.6,
            maxResponseLength: 400,
            greetingMessage: 'Hey hey! Wat speelt er?',
            fallbackMessage: 'Let me connect you.',
            offHoursMessage: 'Closed.',
          },
        }));
      expect(res.status).toBe(200);
      expect(res.body.data.language).toBe('fr');
      expect(res.body.data.guardrails.greetingMessage).toBe('Hey hey! Wat speelt er?');
    });

    it('rejects an unknown language', async () => {
      const res = await request(app)
        .put(`/api/v1/bots/${botId}/ai-settings`)
        .send(fullAiBody({ language: 'de' }));
      expect(res.status).toBe(422);
    });

    it('normalizes empty supportEmail to null', async () => {
      const res = await request(app)
        .put(`/api/v1/bots/${botId}/ai-settings`)
        .send(fullAiBody({ supportEmail: '' }));
      expect(res.status).toBe(200);
      const bot = await AppDataSource.getRepository(Bot).findOneOrFail({ where: { id: botId } });
      expect(bot.settings.ai?.supportEmail).toBeNull();
    });

    it('rejects apiKey/provider/model (strict schema)', async () => {
      for (const bad of [{ apiKey: 'sk-x' }, { provider: 'openai' }, { model: 'gpt-4o' }]) {
        const res = await request(app)
          .put(`/api/v1/bots/${botId}/ai-settings`)
          .send(fullAiBody(bad));
        expect(res.status).toBe(422); // ZodError → ValidationError envelope
      }
    });

    it('forbids supervisor from writing', async () => {
      const sup = await createTestUser(tenantId, { role: 'supervisor' });
      configureMockAuth(auth, { userId: sup.id, tenantId, role: 'supervisor' });
      const res = await request(app).put(`/api/v1/bots/${botId}/ai-settings`).send(fullAiBody());
      expect(res.status).toBe(403);
    });

    it('does NOT auto-provision the tenant webhook when enabling AI (issue #3)', async () => {
      // AI bots are answered by the platform agent, not the dead default n8n
      // webhook — enabling AI must leave tenant.webhookUrl unset.
      await request(app).put(`/api/v1/bots/${botId}/ai-settings`).send(fullAiBody({ enabled: true }));
      const tenant = await AppDataSource.getRepository(Tenant).findOneOrFail({ where: { id: tenantId } });
      expect(tenant.webhookUrl ?? null).toBeNull();
    });
  });

  describe('POST /bots (shared KB attachment)', () => {
    it('attaches the tenant primary KB to a newly created bot', async () => {
      // Enterprise (bots cap=2) so anchor + one new bot fits the quota.
      const ent = await createTestTenant({ tier: 'enterprise' });
      await createTestAnchorBot(ent);
      const u = await createTestUser(ent.id, { role: 'admin' });
      configureMockAuth(auth, { userId: u.id, tenantId: ent.id, role: 'admin' });

      const res = await request(app).post('/api/v1/bots').send({ name: 'Second Bot' });
      expect(res.status).toBe(201);
      const newBotId = res.body.data.id;

      const primary = await AppDataSource.getRepository(KnowledgeBase).findOneOrFail({
        where: { tenantId: ent.id, botId: IsNull() },
      });
      const joins = await AppDataSource.getRepository(BotKnowledgeBase).find({
        where: { botId: newBotId },
      });
      expect(joins).toHaveLength(1);
      expect(joins[0].knowledgeBaseId).toBe(primary.id);
    });
  });

  describe('POST /bots/:id/test-chat', () => {
    it('routes through RAG with the bot KB ids when KB is on and attachments exist', async () => {
      // Enable AI + give the bot a brand voice name.
      await request(app).put(`/api/v1/bots/${botId}/ai-settings`).send(fullAiBody({ enabled: true }));
      const kbId = await attachKb(tenantId, botId);
      mockGenerateResponse.mockResolvedValue({ response: 'rag answer', confidence: 0.9, chunks: [{}] });

      const res = await request(app)
        .post(`/api/v1/bots/${botId}/test-chat`)
        .send({ message: 'hello', useKnowledgeBase: true });

      expect(res.status).toBe(200);
      expect(res.body.data.response).toBe('rag answer');
      expect(mockGenerateResponse).toHaveBeenCalledTimes(1);
      // 6th arg is knowledgeBaseIds — scoped to the bot's attachment.
      expect(mockGenerateResponse.mock.calls[0][5]).toEqual([kbId]);
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('uses the direct LLM (no-KB path) when the bot has no attached KBs', async () => {
      await request(app).put(`/api/v1/bots/${botId}/ai-settings`).send(fullAiBody({ enabled: true }));
      mockChat.mockResolvedValue({ content: 'direct answer' });

      const res = await request(app)
        .post(`/api/v1/bots/${botId}/test-chat`)
        .send({ message: 'hello', useKnowledgeBase: true });

      expect(res.status).toBe(200);
      expect(res.body.data.response).toBe('direct answer');
      expect(mockGenerateResponse).not.toHaveBeenCalled();
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('400s when the bot AI is not enabled', async () => {
      const res = await request(app)
        .post(`/api/v1/bots/${botId}/test-chat`)
        .send({ message: 'hello', useKnowledgeBase: false });
      expect(res.status).toBe(400);
    });

    it('forbids supervisor', async () => {
      const sup = await createTestUser(tenantId, { role: 'supervisor' });
      configureMockAuth(auth, { userId: sup.id, tenantId, role: 'supervisor' });
      const res = await request(app)
        .post(`/api/v1/bots/${botId}/test-chat`)
        .send({ message: 'hello', useKnowledgeBase: false });
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /bots/:id — business hours (operational, tenant-owned)', () => {
    const validBH = {
      enabled: true,
      timezone: 'America/New_York',
      schedule: [
        { day: 'monday', open: '09:00', close: '17:00', closed: false },
        { day: 'saturday', open: '00:00', close: '00:00', closed: true },
      ],
    };

    it('persists businessHours and returns it on the bot GET — with the DERIVED timezone', async () => {
      const patch = await request(app).patch(`/api/v1/bots/${botId}`).send({ businessHours: validBH });
      expect(patch.status).toBe(200);

      const get = await request(app).get(`/api/v1/bots/${botId}`);
      expect(get.status).toBe(200);
      // PR 1a (server-owned Business Time): the client-sent timezone is
      // accepted for compatibility but IGNORED — the schedule round-trips,
      // while the timezone is the bot's canonical businessTimezone.
      expect(get.body.data.businessHours).toEqual({ ...validBH, timezone: 'Europe/Brussels' });
    });

    it('rejects an invalid day name (must match Intl weekday output)', async () => {
      const res = await request(app)
        .patch(`/api/v1/bots/${botId}`)
        .send({ businessHours: { ...validBH, schedule: [{ day: 'mon', open: '09:00', close: '17:00', closed: false }] } });
      expect(res.status).toBe(422);
    });

    it('rejects a malformed time', async () => {
      const res = await request(app)
        .patch(`/api/v1/bots/${botId}`)
        .send({ businessHours: { ...validBH, schedule: [{ day: 'monday', open: '9am', close: '17:00', closed: false }] } });
      expect(res.status).toBe(422);
    });

    it('persists dateOverrides and returns them on GET', async () => {
      const dateOverrides = [
        { date: '2026-12-25', closed: true },
        { date: '2026-12-24', windows: [{ start: '10:00', end: '14:00' }] },
      ];
      const patch = await request(app)
        .patch(`/api/v1/bots/${botId}`)
        .send({ businessHours: { ...validBH, dateOverrides } });
      expect(patch.status).toBe(200);

      const get = await request(app).get(`/api/v1/bots/${botId}`);
      expect(get.status).toBe(200);
      expect(get.body.data.businessHours.dateOverrides).toEqual(dateOverrides);
    });

    it('syncs a closed dateOverride onto an existing AvailabilityRule so that day has no slots', async () => {
      // 2026-08-20 is a Thursday. Seed the rule as Mon–Fri 09–17 so the day is
      // bookable until the bot-form holiday lands.
      const ruleRepo = AppDataSource.getRepository(AvailabilityRule);
      await ruleRepo.save(
        ruleRepo.create({
          tenantId,
          botId,
          timezone: 'UTC',
          availabilityMode: 'business_hours',
          weeklyHours: {
            mon: [{ start: '09:00', end: '17:00' }],
            tue: [{ start: '09:00', end: '17:00' }],
            wed: [{ start: '09:00', end: '17:00' }],
            thu: [{ start: '09:00', end: '17:00' }],
            fri: [{ start: '09:00', end: '17:00' }],
          },
          dateOverrides: [],
          slotGranularityMin: 15,
        }),
      );

      const dateOverrides = [{ date: '2026-08-20', closed: true }];
      const patch = await request(app)
        .patch(`/api/v1/bots/${botId}`)
        .send({
          businessHours: {
            enabled: true,
            schedule: [
              { day: 'monday', open: '09:00', close: '17:00', closed: false },
              { day: 'tuesday', open: '09:00', close: '17:00', closed: false },
              { day: 'wednesday', open: '09:00', close: '17:00', closed: false },
              { day: 'thursday', open: '09:00', close: '17:00', closed: false },
              { day: 'friday', open: '09:00', close: '17:00', closed: false },
              { day: 'saturday', open: '00:00', close: '00:00', closed: true },
              { day: 'sunday', open: '00:00', close: '00:00', closed: true },
            ],
            dateOverrides,
          },
        });
      expect(patch.status).toBe(200);

      const rule = await ruleRepo.findOneOrFail({ where: { botId } });
      expect(rule.dateOverrides).toEqual(dateOverrides);
      expect(rule.weeklyHours.thu).toEqual([{ start: '09:00', end: '17:00' }]);
      // Other rule fields must survive the hours write.
      expect(rule.availabilityMode).toBe('business_hours');
      expect(rule.slotGranularityMin).toBe(15);

      const slotInput = {
        eventType: {
          durationMin: 30,
          bufferBeforeMin: 0,
          bufferAfterMin: 0,
          minNoticeMin: 0,
          maxHorizonDays: 60,
        },
        now: new Date('2026-08-01T00:00:00Z'),
        busy: [],
      };
      expect(
        computeSlots({
          ...slotInput,
          rule,
          rangeStart: '2026-08-20T00:00:00Z',
          rangeEnd: '2026-08-21T00:00:00Z',
        }),
      ).toEqual([]);
      expect(
        computeSlots({
          ...slotInput,
          rule,
          rangeStart: '2026-08-21T00:00:00Z',
          rangeEnd: '2026-08-22T00:00:00Z',
        }).length,
      ).toBeGreaterThan(0);
    });

    it('maps a closed weekday onto weeklyHours (no Thursday window)', async () => {
      const ruleRepo = AppDataSource.getRepository(AvailabilityRule);
      await ruleRepo.save(
        ruleRepo.create({
          tenantId,
          botId,
          timezone: 'UTC',
          weeklyHours: { thu: [{ start: '09:00', end: '17:00' }], fri: [{ start: '09:00', end: '17:00' }] },
          dateOverrides: [],
        }),
      );

      const patch = await request(app)
        .patch(`/api/v1/bots/${botId}`)
        .send({
          businessHours: {
            enabled: true,
            schedule: [
              { day: 'thursday', open: '09:00', close: '17:00', closed: true },
              { day: 'friday', open: '09:00', close: '17:00', closed: false },
            ],
          },
        });
      expect(patch.status).toBe(200);

      const rule = await ruleRepo.findOneOrFail({ where: { botId } });
      expect(rule.weeklyHours).toEqual({ fri: [{ start: '09:00', end: '17:00' }] });
      expect(rule.weeklyHours).not.toHaveProperty('thu');
    });

    it('does not rewrite the AvailabilityRule when spoken hours are disabled', async () => {
      const existingHours = {
        thu: [{ start: '09:00', end: '17:00' }],
        fri: [{ start: '10:00', end: '16:00' }],
      };
      const existingOverrides = [{ date: '2026-12-25', closed: true }];
      const ruleRepo = AppDataSource.getRepository(AvailabilityRule);
      await ruleRepo.save(
        ruleRepo.create({
          tenantId,
          botId,
          timezone: 'UTC',
          weeklyHours: existingHours,
          dateOverrides: existingOverrides,
          slotGranularityMin: 15,
        }),
      );

      const patch = await request(app)
        .patch(`/api/v1/bots/${botId}`)
        .send({
          businessHours: {
            enabled: false,
            schedule: [{ day: 'monday', open: '08:00', close: '12:00', closed: false }],
            dateOverrides: [{ date: '2026-08-20', closed: true }],
          },
        });
      expect(patch.status).toBe(200);

      const rule = await ruleRepo.findOneOrFail({ where: { botId } });
      expect(rule.weeklyHours).toEqual(existingHours);
      expect(rule.dateOverrides).toEqual(existingOverrides);
      expect(rule.slotGranularityMin).toBe(15);
    });

    it('does not create an AvailabilityRule when the bot has none', async () => {
      const ruleRepo = AppDataSource.getRepository(AvailabilityRule);
      await expect(ruleRepo.findOne({ where: { botId } })).resolves.toBeNull();

      const patch = await request(app)
        .patch(`/api/v1/bots/${botId}`)
        .send({
          businessHours: {
            enabled: true,
            schedule: [{ day: 'monday', open: '09:00', close: '17:00', closed: false }],
            dateOverrides: [{ date: '2026-08-20', closed: true }],
          },
        });
      expect(patch.status).toBe(200);
      await expect(ruleRepo.findOne({ where: { botId } })).resolves.toBeNull();
      await expect(ruleRepo.count({ where: { botId } })).resolves.toBe(0);
    });
  });
});
