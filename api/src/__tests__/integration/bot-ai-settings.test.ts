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
import { createTestTenant, createTestAnchorBot, createTestUser } from '../helpers/factories';

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
          usePlatformAgent: false,
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

  describe('GET /bots/:id/ai-settings', () => {
    it('returns the bot ai shape with hasApiKey and never leaks apiKey', async () => {
      const res = await request(app).get(`/api/v1/bots/${botId}/ai-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.brandVoice.name).toBe('Existing');
      expect(res.body.data.hasApiKey).toBe(true);
      expect(res.body.data.apiKey).toBeUndefined();
    });

    it('fills a full default shape when the bot has no ai settings', async () => {
      const t = await createTestTenant();
      const b = await createTestAnchorBot(t, { settings: {} as Bot['settings'] });
      const u = await createTestUser(t.id, { role: 'admin' });
      configureMockAuth(auth, { userId: u.id, tenantId: t.id, role: 'admin' });

      const res = await request(app).get(`/api/v1/bots/${b.id}/ai-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);
      expect(res.body.data.provider).toBe('openai');
      expect(res.body.data.model).toBe('gpt-4o-mini');
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
    it('full-replaces editable fields and preserves provider/model/usePlatformAgent', async () => {
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
      expect(bot.settings.ai?.usePlatformAgent).toBe(false);
      // Never persisted onto the bot.
      expect((bot.settings.ai as Record<string, unknown>).apiKey).toBeUndefined();
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
});
