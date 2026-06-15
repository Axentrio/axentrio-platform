/**
 * Tenant-facing bot↔template binding (.scratch/plan-bot-templates.md, Phase 4).
 * Covers GET /bots/:id/templates and PUT /bots/:id/template (availability gate,
 * version validation, persistence, missing-module advisory) + the T18
 * deprecation: PUT /bots/:id/ai-settings accepts but never persists templateId.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({ clerkMiddleware: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../../websocket/socket.handler', () => ({ emitToSession: vi.fn(), emitToTenantAgents: vi.fn(), emitToAgent: vi.fn() }));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { BotTemplate } from '../../database/entities/BotTemplate';
import { BotTemplateVersion } from '../../database/entities/BotTemplateVersion';
import { TenantBotTemplate } from '../../database/entities/TenantBotTemplate';
import { app } from '../../server';
import { createTestTenant, createTestAnchorBot, createTestUser } from '../helpers/factories';

let keyN = 0;
async function makeTemplate(opts: {
  availableToAllTenants?: boolean;
  versions?: Array<{ version: number; body: string; status?: 'draft' | 'published' | 'unpublished'; expectedModules?: string[] }>;
}): Promise<BotTemplate> {
  const t = await AppDataSource.getRepository(BotTemplate).save({
    key: `bind-tmpl-${++keyN}`, displayName: 'T', availableToAllTenants: opts.availableToAllTenants ?? false, status: 'active',
  });
  for (const v of opts.versions ?? []) {
    await AppDataSource.getRepository(BotTemplateVersion).save({
      templateId: t.id, version: v.version, body: v.body, status: v.status ?? 'published', expectedModules: v.expectedModules ?? [],
    });
  }
  return t;
}

describe('bot template binding', () => {
  let tenantId: string;
  let botId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'enterprise' });
    tenantId = tenant.id;
    const bot = await createTestAnchorBot(tenant);
    botId = bot.id;
    const admin = await createTestUser(tenantId, { role: 'admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'admin' });
  });

  describe('GET /bots/:id/templates', () => {
    it('lists globally-available templates and the current (unbound) binding', async () => {
      const tpl = await makeTemplate({ availableToAllTenants: true, versions: [{ version: 1, body: 'v1' }] });
      const res = await request(app).get(`/api/v1/bots/${botId}/templates`);
      expect(res.status).toBe(200);
      expect(res.body.data.available.some((t: any) => t.id === tpl.id)).toBe(true);
      expect(res.body.data.binding.templateId).toBeNull();
    });
  });

  describe('PUT /bots/:id/template', () => {
    it('binds an available template at latest and resolves the published version', async () => {
      const tpl = await makeTemplate({ availableToAllTenants: true, versions: [{ version: 1, body: 'a' }, { version: 2, body: 'b' }] });
      const res = await request(app).put(`/api/v1/bots/${botId}/template`).send({ templateId: tpl.id, templateVersion: 'latest' });
      expect(res.status).toBe(200);
      expect(res.body.data.binding).toEqual({ templateId: tpl.id, templateVersion: 'latest' });
      expect(res.body.data.resolved.resolvedVersion).toBe(2);
      expect(res.body.data.publishedVersions).toEqual([2, 1]);

      const reloaded = await AppDataSource.getRepository(Bot).findOneByOrFail({ id: botId });
      expect(reloaded.templateId).toBe(tpl.id);
      expect(reloaded.templateVersion).toBe('latest');
    });

    it('binds a fixed published version pin', async () => {
      const tpl = await makeTemplate({ availableToAllTenants: true, versions: [{ version: 1, body: 'a' }, { version: 2, body: 'b' }] });
      const res = await request(app).put(`/api/v1/bots/${botId}/template`).send({ templateId: tpl.id, templateVersion: '1' });
      expect(res.status).toBe(200);
      expect(res.body.data.resolved.resolvedVersion).toBe(1);
    });

    it('rejects a template the tenant cannot access (403)', async () => {
      const tpl = await makeTemplate({ availableToAllTenants: false, versions: [{ version: 1, body: 'a' }] }); // not granted
      const res = await request(app).put(`/api/v1/bots/${botId}/template`).send({ templateId: tpl.id, templateVersion: 'latest' });
      expect(res.status).toBe(403);
    });

    it('allows a granted (non-global) template once granted', async () => {
      const tpl = await makeTemplate({ availableToAllTenants: false, versions: [{ version: 1, body: 'a' }] });
      await AppDataSource.getRepository(TenantBotTemplate).save({ tenantId, templateId: tpl.id });
      const res = await request(app).put(`/api/v1/bots/${botId}/template`).send({ templateId: tpl.id, templateVersion: 'latest' });
      expect(res.status).toBe(200);
    });

    it('rejects a fixed pin to a non-published version (422)', async () => {
      const tpl = await makeTemplate({ availableToAllTenants: true, versions: [{ version: 1, body: 'a' }, { version: 2, body: 'd', status: 'draft' }] });
      const res = await request(app).put(`/api/v1/bots/${botId}/template`).send({ templateId: tpl.id, templateVersion: '2' });
      expect(res.status).toBe(422);
    });

    it('reports expectedModules the tenant lacks as missingModules (advisory)', async () => {
      // Essential tenant: billable but bookings feature off → booking module inactive.
      const essential = await createTestTenant({ tier: 'essential' });
      const bot = await createTestAnchorBot(essential);
      const admin = await createTestUser(essential.id, { role: 'admin' });
      configureMockAuth(auth, { userId: admin.id, tenantId: essential.id, role: 'admin' });

      const tpl = await makeTemplate({ availableToAllTenants: true, versions: [{ version: 1, body: 'a', expectedModules: ['booking'] }] });
      const res = await request(app).put(`/api/v1/bots/${bot.id}/template`).send({ templateId: tpl.id, templateVersion: 'latest' });
      expect(res.status).toBe(200);
      expect(res.body.data.missingModules).toContain('booking');
    });
  });

  describe('multi-template binding (up to 3, AND/OR)', () => {
    it('binds 2 templates with mode and returns both bindings', async () => {
      const a = await makeTemplate({ availableToAllTenants: true, versions: [{ version: 1, body: 'Plumbing role' }] });
      const b = await makeTemplate({ availableToAllTenants: true, versions: [{ version: 1, body: 'Electrical role' }] });
      const res = await request(app).put(`/api/v1/bots/${botId}/template`).send({
        bindings: [{ templateId: a.id, version: 'latest' }, { templateId: b.id, version: 'latest' }],
        mode: 'or',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.mode).toBe('or');
      expect(res.body.data.bindings.map((x: any) => x.templateId)).toEqual([a.id, b.id]);
      // primary mirrored for back-compat
      expect(res.body.data.binding.templateId).toBe(a.id);
      const reloaded = await AppDataSource.getRepository(Bot).findOneByOrFail({ id: botId });
      expect(reloaded.templateBindings.length).toBe(2);
      expect(reloaded.templateMode).toBe('or');
    });

    it('rejects more than 3 templates (422)', async () => {
      const mk = async () => (await makeTemplate({ availableToAllTenants: true, versions: [{ version: 1, body: 'x' }] })).id;
      const ids = [await mk(), await mk(), await mk(), await mk()];
      const res = await request(app).put(`/api/v1/bots/${botId}/template`).send({
        bindings: ids.map((id) => ({ templateId: id, version: 'latest' })),
      });
      expect(res.status).toBe(422);
    });

    it('rejects the same template bound twice (422)', async () => {
      const a = await makeTemplate({ availableToAllTenants: true, versions: [{ version: 1, body: 'x' }] });
      const res = await request(app).put(`/api/v1/bots/${botId}/template`).send({
        bindings: [{ templateId: a.id, version: 'latest' }, { templateId: a.id, version: 'latest' }],
      });
      expect(res.status).toBe(422);
    });

    it('rejects a binding set containing an unavailable template (403)', async () => {
      const ok = await makeTemplate({ availableToAllTenants: true, versions: [{ version: 1, body: 'x' }] });
      const no = await makeTemplate({ availableToAllTenants: false, versions: [{ version: 1, body: 'y' }] });
      const res = await request(app).put(`/api/v1/bots/${botId}/template`).send({
        bindings: [{ templateId: ok.id, version: 'latest' }, { templateId: no.id, version: 'latest' }],
      });
      expect(res.status).toBe(403);
    });
  });

  describe('T18 — ai-settings ignores legacy templateId', () => {
    it('accepts a templateId in the ai-settings body but never persists it', async () => {
      const res = await request(app).put(`/api/v1/bots/${botId}/ai-settings`).send({
        enabled: true,
        supportEmail: null,
        brandVoice: { name: 'Bot', tone: 'friendly', customInstructions: 'Hi', templateId: 'legacy-snippet' },
        guardrails: { topicsToAvoid: [], escalationKeywords: [], confidenceThreshold: 0.7, maxResponseLength: 500, greetingMessage: '', fallbackMessage: '', offHoursMessage: '' },
      });
      expect(res.status).toBe(200);
      const reloaded = await AppDataSource.getRepository(Bot).findOneByOrFail({ id: botId });
      expect((reloaded.settings?.ai?.brandVoice as Record<string, unknown>)?.templateId).toBeUndefined();
    });
  });
});
