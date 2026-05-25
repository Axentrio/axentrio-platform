/**
 * Integration tests for the multi-bot Phase 4 (#16d) per-bot config cutover.
 *
 * These tests are the canary for the read/write asymmetry bug — if any of
 * them fail, it means an admin write went to tenant.settings (silently no-op)
 * or a response hydrated from tenant.settings (showing stale data).
 *
 * Scenarios:
 *   1. PATCH /tenants/me with `settings.theme.primaryColor` → write lands on
 *      bot.settings, NOT tenant.settings.theme.primaryColor.
 *   2. PATCH /tenants/me/ai-settings with `apiKey` → write lands on
 *      tenant.settings.ai.apiKey, NOT bot.settings.ai.apiKey.
 *   3. GET /widget-appearance hydrates from bot.settings (not tenant.settings)
 *      when the two diverge.
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

import request from 'supertest';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { Bot } from '../../database/entities/Bot';
import { app } from '../../server';
import {
  createTestTenant,
  createTestUser,
  createTestAnchorBot,
} from '../helpers/factories';

describe('Multi-bot #16d — per-bot config cutover', () => {
  let tenantId: string;
  let anchorBotId: string;

  beforeEach(async () => {
    const tenant = await createTestTenant({
      settings: {
        // Seed legacy values on tenant — they must NOT change after writes.
        theme: { primaryColor: '#legacy-tenant-color', logoUrl: 'https://tenant-logo.png' },
        ai: { apiKey: 'sk-existing-tenant-key' } as Tenant['settings']['ai'],
      } as Tenant['settings'],
    });
    tenantId = tenant.id;
    const anchor = await createTestAnchorBot(tenant, {
      settings: {
        theme: { primaryColor: '#bot-color-pre' },
      } as Bot['settings'],
    });
    anchorBotId = anchor.id;

    const admin = await createTestUser(tenantId, { role: 'admin' });
    configureMockAuth(auth, {
      userId: admin.id,
      tenantId,
      role: 'admin',
    });
  });

  it('PATCH /tenants/me writes settings.theme.primaryColor to bot.settings, NOT tenant.settings', async () => {
    const res = await request(app)
      .patch('/api/v1/tenants/me')
      .send({ settings: { theme: { primaryColor: '#brand-new' } } });

    expect(res.status).toBe(200);

    // 1. Bot received the update.
    const bot = await AppDataSource.getRepository(Bot).findOneOrFail({ where: { id: anchorBotId } });
    expect(bot.settings.theme?.primaryColor).toBe('#brand-new');

    // 2. Tenant.settings.theme is UNCHANGED — legacy keys left alone per the
    //    "leave legacy untouched" architectural rule.
    const tenant = await AppDataSource.getRepository(Tenant).findOneOrFail({ where: { id: tenantId } });
    expect(tenant.settings?.theme?.primaryColor).toBe('#legacy-tenant-color');
    expect(tenant.settings?.theme?.logoUrl).toBe('https://tenant-logo.png');

    // 3. Response hydrates from bot.settings (no stale tenant value leaking).
    expect(res.body.data.settings.theme.primaryColor).toBe('#brand-new');
  });

  it('PATCH /tenants/me/ai-settings with apiKey writes to tenant.settings.ai.apiKey, NOT bot.settings.ai.apiKey', async () => {
    const res = await request(app)
      .patch('/api/v1/tenants/me/ai-settings')
      .send({
        enabled: true,
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-new-secret-for-tenant',
        brandVoice: { name: 'TestBot', tone: 'friendly', customInstructions: '' },
        guardrails: {
          topicsToAvoid: [],
          escalationKeywords: [],
          confidenceThreshold: 0.7,
          maxResponseLength: 500,
          greetingMessage: '',
          fallbackMessage: 'fallback',
          offHoursMessage: '',
        },
      });

    expect(res.status).toBe(200);

    // 1. apiKey landed on Tenant.
    const tenant = await AppDataSource.getRepository(Tenant).findOneOrFail({ where: { id: tenantId } });
    expect(tenant.settings?.ai?.apiKey).toBeDefined();
    expect(tenant.settings?.ai?.apiKey).not.toBe('sk-new-secret-for-tenant'); // encrypted
    expect(tenant.settings?.ai?.apiKey).not.toBeNull();

    // 2. Bot.settings.ai is updated for the behavioural slice but does NOT
    //    carry apiKey.
    const bot = await AppDataSource.getRepository(Bot).findOneOrFail({ where: { id: anchorBotId } });
    expect(bot.settings.ai?.brandVoice?.name).toBe('TestBot');
    expect(bot.settings.ai?.provider).toBe('openai');
    expect((bot.settings.ai as any)?.apiKey).toBeUndefined();

    // 3. Response shape carries hasApiKey true and no apiKey leak.
    expect(res.body.data.hasApiKey).toBe(true);
    expect(res.body.data.apiKey).toBeUndefined();
  });

  it('PATCH /tenants/me/integrations Cal.com writes to bot.settings.integrations.calcom, NOT tenant.settings (covers the wholesale-section-replacement path)', async () => {
    // Seed legacy tenant integrations so we can verify they're untouched.
    await AppDataSource.getRepository(Tenant).update(
      { id: tenantId },
      {
        settings: {
          ...{ theme: { primaryColor: '#legacy-tenant-color', logoUrl: 'https://tenant-logo.png' } },
          ai: { apiKey: 'sk-existing-tenant-key' },
          integrations: { calcom: { apiKey: 'legacy-tenant-calcom-key' } },
        } as Tenant['settings'],
      },
    );

    const res = await request(app)
      .patch('/api/v1/tenants/me/integrations')
      .send({
        calcom: {
          apiKey: 'cal-live-new-key',
          eventTypeId: 12345,
          collectFields: ['name', 'email'],
          language: 'en',
        },
      });

    expect(res.status).toBe(200);

    // 1. Bot received the new Cal.com config — section-replacement writer
    //    means subkeys not in the new value are dropped, but the existing
    //    `integrations` shape is fully replaced.
    const bot = await AppDataSource.getRepository(Bot).findOneOrFail({ where: { id: anchorBotId } });
    expect((bot.settings.integrations?.calcom as any)?.eventTypeId).toBe(12345);
    expect((bot.settings.integrations?.calcom as any)?.language).toBe('en');
    // apiKey is encrypted at rest — verify it was transformed (not stored raw).
    expect((bot.settings.integrations?.calcom as any)?.apiKey).toBeTruthy();
    expect((bot.settings.integrations?.calcom as any)?.apiKey).not.toBe('cal-live-new-key');

    // 2. Tenant.settings.integrations is UNCHANGED — legacy keys left alone.
    const tenant = await AppDataSource.getRepository(Tenant).findOneOrFail({ where: { id: tenantId } });
    expect((tenant.settings?.integrations as any)?.calcom?.apiKey).toBe('legacy-tenant-calcom-key');
    expect((tenant.settings?.integrations as any)?.calcom?.eventTypeId).toBeUndefined();
  });

  it('GET /widget-appearance hydrates from bot.settings, not tenant.settings (no read/write asymmetry)', async () => {
    // Force divergence: bot says "#bot-only", tenant says "#legacy-tenant-color".
    await AppDataSource.getRepository(Bot).update(
      { id: anchorBotId },
      { settings: { theme: { primaryColor: '#bot-only' } } as Bot['settings'] },
    );

    const res = await request(app).get('/api/v1/tenants/me/widget-appearance');

    expect(res.status).toBe(200);
    expect(res.body.data.primaryColor).toBe('#bot-only');
    expect(res.body.data.primaryColor).not.toBe('#legacy-tenant-color');
  });
});
