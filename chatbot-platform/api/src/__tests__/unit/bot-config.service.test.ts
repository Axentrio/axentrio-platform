/**
 * Unit tests for the bot-config resolvers + writer introduced by #16d.
 *
 * Covers:
 *   - getBotConfigForSession returns the session.botId bot when set
 *   - Anchor-fallback when session.botId is null (and logs)
 *   - BotPausedConfigError when session.botId points to a paused bot
 *   - BotNotFoundConfigError when session.botId is soft-deleted
 *   - getAnchorBotConfig throws AnchorBotMissingError when no anchor exists
 *   - getLlmRuntimeConfigForSession returns separate botAiSettings + apiKey
 *   - updateAnchorBotSettings section-level deep-merge (theme.primaryColor
 *     preserves theme.logoUrl)
 *   - updateAnchorBotSettings array replacement (skills replaces wholesale)
 *
 * Integration-style: backed by the real Postgres test DB. Uses the project's
 * factories so paused/deleted state matches production semantics.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { Tenant } from '../../database/entities/Tenant';
import {
  getBotConfigForSession,
  getAnchorBotConfig,
  getLlmRuntimeConfigForSession,
  updateAnchorBotSettings,
  BotPausedConfigError,
  BotNotFoundConfigError,
  AnchorBotMissingError,
} from '../../services/bot-config.service';
import {
  createTestTenant,
  createTestAnchorBot,
  createTestSession,
} from '../helpers/factories';

async function createSecondaryBot(
  tenantId: string,
  overrides: Partial<Bot> = {},
): Promise<Bot> {
  const repo = AppDataSource.getRepository(Bot);
  return repo.save(
    repo.create({
      tenantId,
      name: 'Secondary',
      publicKey: `bk_${crypto.randomBytes(16).toString('hex')}`,
      status: 'active',
      isDefault: false,
      settings: {} as Bot['settings'],
      ...overrides,
    }),
  );
}

describe('getBotConfigForSession', () => {
  it('returns the session.botId bot when set', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant);
    const secondary = await createSecondaryBot(tenant.id, {
      settings: { theme: { primaryColor: '#abcdef' } } as Bot['settings'],
    });
    const session = await createTestSession(tenant.id, { botId: secondary.id });

    const { bot, settings } = await getBotConfigForSession(session);

    expect(bot.id).toBe(secondary.id);
    expect(settings.theme?.primaryColor).toBe('#abcdef');
  });

  it('falls back to the anchor when session.botId is null', async () => {
    const tenant = await createTestTenant();
    const anchor = await createTestAnchorBot(tenant, {
      settings: { theme: { primaryColor: '#anchor1' } } as Bot['settings'],
    });
    const session = await createTestSession(tenant.id, { botId: null as any });

    const { bot, settings } = await getBotConfigForSession(session);

    expect(bot.id).toBe(anchor.id);
    expect(settings.theme?.primaryColor).toBe('#anchor1');
  });

  it('throws BotPausedConfigError when session.botId points to a paused bot', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant);
    const paused = await createSecondaryBot(tenant.id, { status: 'paused' });
    const session = await createTestSession(tenant.id, { botId: paused.id });

    await expect(getBotConfigForSession(session)).rejects.toBeInstanceOf(BotPausedConfigError);
  });

  it('throws BotNotFoundConfigError when session.botId points to a soft-deleted bot', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant);
    const deleted = await createSecondaryBot(tenant.id, { deletedAt: new Date() });
    const session = await createTestSession(tenant.id, { botId: deleted.id });

    await expect(getBotConfigForSession(session)).rejects.toBeInstanceOf(BotNotFoundConfigError);
  });
});

describe('getAnchorBotConfig', () => {
  it('throws AnchorBotMissingError when no anchor exists', async () => {
    const tenant = await createTestTenant();
    // No anchor created.

    await expect(getAnchorBotConfig(tenant.id)).rejects.toBeInstanceOf(AnchorBotMissingError);
  });

  it('returns the anchor bot and its settings', async () => {
    const tenant = await createTestTenant();
    const anchor = await createTestAnchorBot(tenant, {
      settings: { features: { fileUploadEnabled: true, handoffEnabled: false } } as Bot['settings'],
    });

    const { bot, settings } = await getAnchorBotConfig(tenant.id);
    expect(bot.id).toBe(anchor.id);
    expect(settings.features?.fileUploadEnabled).toBe(true);
    expect(settings.features?.handoffEnabled).toBe(false);
  });
});

describe('getLlmRuntimeConfigForSession', () => {
  it('returns separate botAiSettings + apiKey (apiKey sourced from Tenant)', async () => {
    const tenant = await createTestTenant({
      settings: {
        ai: {
          enabled: true,
          apiKey: 'sk-secret-from-tenant',
        },
      } as Tenant['settings'],
    });
    const anchor = await createTestAnchorBot(tenant, {
      settings: {
        ai: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-4o-mini',
          brandVoice: { name: 'BotBrand', tone: 'friendly', customInstructions: '' },
          guardrails: {
            topicsToAvoid: [],
            escalationKeywords: [],
            confidenceThreshold: 0.7,
            maxResponseLength: 500,
            greetingMessage: '',
            fallbackMessage: 'fallback',
            offHoursMessage: '',
          },
        },
      } as Bot['settings'],
    });
    const session = await createTestSession(tenant.id, { botId: anchor.id });

    const { botAiSettings, apiKey } = await getLlmRuntimeConfigForSession(session);

    expect(botAiSettings?.provider).toBe('openai');
    expect(botAiSettings?.brandVoice?.name).toBe('BotBrand');
    // apiKey comes from tenant, not the bot.
    expect(apiKey).toBe('sk-secret-from-tenant');
    // And critically — apiKey is NOT on the bot side.
    expect((botAiSettings as any)?.apiKey).toBeUndefined();
  });
});

describe('updateAnchorBotSettings', () => {
  it('section-level deep merge: updating theme.primaryColor preserves theme.logoUrl', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant, {
      settings: {
        theme: { primaryColor: '#oldcolor', logoUrl: 'https://logo.png' },
      } as Bot['settings'],
    });

    const updated = await updateAnchorBotSettings(tenant.id, {
      theme: { primaryColor: '#newcolor' },
    });

    expect(updated.settings.theme?.primaryColor).toBe('#newcolor');
    // Preserved.
    expect(updated.settings.theme?.logoUrl).toBe('https://logo.png');
  });

  it('replaces top-level untouched sections only with what was provided (no implicit reset)', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant, {
      settings: {
        theme: { primaryColor: '#aaa' },
        widget: { launcherLabel: 'Hi', launcherPosition: 'bottom-left' },
      } as Bot['settings'],
    });

    const updated = await updateAnchorBotSettings(tenant.id, {
      theme: { primaryColor: '#bbb' },
    });

    expect(updated.settings.theme?.primaryColor).toBe('#bbb');
    // Widget block is untouched (not erased) because we didn't pass it.
    expect(updated.settings.widget?.launcherLabel).toBe('Hi');
    expect(updated.settings.widget?.launcherPosition).toBe('bottom-left');
  });

  it('arrays (skills) replace wholesale — no element-wise merge', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant, {
      settings: {
        skills: [
          { name: 'old1', trigger: 'x', tools: [], instructions: 'A', maxSteps: 5, enabled: true },
          { name: 'old2', trigger: 'y', tools: [], instructions: 'B', maxSteps: 5, enabled: true },
        ],
      } as Bot['settings'],
    });

    const updated = await updateAnchorBotSettings(tenant.id, {
      skills: [
        { name: 'new1', trigger: 'z', tools: [], instructions: 'C', maxSteps: 5, enabled: true },
      ],
    });

    expect(updated.settings.skills?.length).toBe(1);
    expect(updated.settings.skills?.[0].name).toBe('new1');
  });

  it('throws AnchorBotMissingError when no anchor exists for the tenant', async () => {
    const tenant = await createTestTenant();
    // No anchor created.
    await expect(updateAnchorBotSettings(tenant.id, { theme: { primaryColor: '#x' } }))
      .rejects.toBeInstanceOf(AnchorBotMissingError);
  });
});
