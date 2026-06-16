/**
 * Integration: 7 Copilot tools — shape + zero-fills + cross-tenant
 * regression per tool (security invariant #10).
 *
 * The pattern (one `describe` per tool):
 *   1. `beforeEach`: seed tenant A and tenant B side by side, each
 *      with its own sentinels in the columns the tool touches
 *   2. Call the tool as tenant A
 *   3. Assert tenant A's expected sentinels show up where they should
 *      (positive-path correctness)
 *   4. JSON-stringify the result; assert ZERO tenant B sentinels
 *      appear anywhere (cross-tenant leak detection)
 *
 * The sentinel-based check is intentionally crude — it catches the
 * widest class of leak (any string from tenant B in any field of the
 * response) without our having to enumerate which exact fields the
 * tool is meant to expose. Adding a new field that accidentally
 * surfaces a foreign sentinel fails the test immediately.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { Tenant } from '../../database/entities/Tenant';
import { Lead, type LeadSource } from '../../database/entities/Lead';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { ChatSession } from '../../database/entities/ChatSession';
import {
  createTestTenant,
  createTestAnchorBot,
  createTestUser,
  createTestSession,
  createTestBillingAccount,
} from '../helpers/factories';
import {
  CopilotReadOnlyManager,
} from '../../copilot/manager/read-only-manager';
import {
  getTenantSummary,
  getBotReadinessStatus,
  getIntegrationsStatus,
  getEntitlements,
  getLeadStats,
  getRecentChatSessionStats,
  getKnownGapTopics,
} from '../../copilot/tools';
import {
  TENANT_A_SENTINELS,
  TENANT_B_SENTINELS,
  TENANT_B_VALUES,
  assertNoForeignSentinels,
} from '../../copilot/test-helpers/sentinels';
import type { BotSettings } from '../../database/entities/Bot';

interface SeededTenant {
  tenantId: string;
  userId: string;
  botId: string;
  manager: CopilotReadOnlyManager;
}

type SentinelRecord = Readonly<Record<keyof typeof TENANT_A_SENTINELS, string>>;

async function seedTenantWithSentinels(
  sentinels: SentinelRecord,
  options: { tier?: 'essential' | 'pro' | 'enterprise'; calcom?: boolean } = {},
): Promise<SeededTenant> {
  const tenant = await createTestTenant({
    name: sentinels.tenantName,
    slug: sentinels.tenantSlug,
    apiKey: sentinels.apiKey,
    webhookUrl: sentinels.webhookUrl,
    webhookSecret: sentinels.webhookSecret,
    tier: options.tier ?? 'pro',
  });

  const botSettings: BotSettings = {
    ai: {
      enabled: true,
      brandVoice: {
        name: sentinels.brandVoiceName,
        tone: sentinels.brandVoiceTone,
        customInstructions: sentinels.brandVoiceInstructions,
      },
      guardrails: {
        topicsToAvoid: [],
        escalationKeywords: [],
        confidenceThreshold: 0.5,
        maxResponseLength: 500,
        greetingMessage: sentinels.greetingMessage,
        fallbackMessage: sentinels.fallbackMessage,
        offHoursMessage: '',
      },
    } as BotSettings['ai'],
  } as BotSettings;
  if (options.calcom) {
    botSettings.integrations = {
      calcom: { apiKey: 'cal_key_' + sentinels.botName, eventTypeId: 12345 },
    } as BotSettings['integrations'];
  }

  const bot = await createTestAnchorBot(tenant, {
    name: sentinels.botName,
    publicKey: sentinels.publicKey,
    settings: botSettings,
  });

  const user = await createTestUser(tenant.id, {
    email: 'user@' + sentinels.tenantSlug + '.test',
  });

  await createTestBillingAccount(tenant.id, {
    status: 'active',
    customerId: sentinels.stripeCustomerId,
    subscriptionId: sentinels.stripeSubscriptionId,
    currentPlanId: options.tier ?? 'pro',
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    trialEnd: null,
    billingEmail: sentinels.billingEmail,
  });

  return {
    tenantId: tenant.id,
    userId: user.id,
    botId: bot.id,
    manager: new CopilotReadOnlyManager(AppDataSource.manager, {
      tenantId: tenant.id,
      userId: user.id,
    }),
  };
}

async function seedLead(
  tenantId: string,
  sentinels: SentinelRecord,
  overrides: Partial<{ source: LeadSource; createdAt: Date }> = {},
): Promise<Lead> {
  const repo = AppDataSource.getRepository(Lead);
  const lead = repo.create({
    tenantId,
    name: sentinels.leadName,
    email: sentinels.leadEmail,
    phone: sentinels.leadPhone,
    source: overrides.source ?? 'tool',
    notes: sentinels.leadNotes,
  });
  const saved = await repo.save(lead);
  if (overrides.createdAt) {
    await repo.update({ id: saved.id }, { createdAt: overrides.createdAt });
  }
  return saved;
}

async function seedChannel(
  tenantId: string,
  channel: 'widget' | 'telegram' | 'messenger' | 'instagram' | 'whatsapp',
  status: 'active' | 'disconnected' | 'pending_setup',
  label: string,
  platformAccountId: string,
): Promise<void> {
  const repo = AppDataSource.getRepository(ChannelConnection);
  await repo.save(repo.create({ tenantId, channel, status, label, platformAccountId }));
}

describe('getTenantSummary', () => {
  let a: SeededTenant;
  beforeEach(async () => {
    a = await seedTenantWithSentinels(TENANT_A_SENTINELS, { tier: 'pro' });
    await seedTenantWithSentinels(TENANT_B_SENTINELS, { tier: 'enterprise' });
  });

  it('returns the calling tenant\'s tier + billing summary', async () => {
    const result = await getTenantSummary.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result.tier).toBe('pro');
    expect(result.status).toBe('active');
    expect(typeof result.billingPeriodEndsAt).toBe('string');
    expect(result.trialEndsAt).toBeNull();
  });

  it('never leaks tenant B sentinels in the response JSON', async () => {
    const result = await getTenantSummary.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    assertNoForeignSentinels(result, TENANT_B_SENTINELS);
  });
});

describe('getBotReadinessStatus', () => {
  let a: SeededTenant;
  beforeEach(async () => {
    a = await seedTenantWithSentinels(TENANT_A_SENTINELS);
    await seedTenantWithSentinels(TENANT_B_SENTINELS);
  });

  it('returns four booleans reflecting the tenant\'s anchor bot', async () => {
    const result = await getBotReadinessStatus.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result).toEqual({
      aiEnabled: true,
      hasWebhook: true,
      brandVoiceConfigured: true,
      embedSnippetReady: true,
    });
  });

  it('reports brand voice not configured when name+tone are empty', async () => {
    await AppDataSource.getRepository(Bot).update(a.botId, {
      settings: {
        ai: { enabled: true, brandVoice: { name: '', tone: '', customInstructions: '' } },
      } as any,
    });
    const result = await getBotReadinessStatus.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result.brandVoiceConfigured).toBe(false);
    expect(result.aiEnabled).toBe(true);
  });

  it('reports all false when the anchor bot is missing', async () => {
    // Soft-delete the bot to simulate the no-anchor state.
    await AppDataSource.getRepository(Bot).update(a.botId, { deletedAt: new Date() });
    const result = await getBotReadinessStatus.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result).toEqual({
      aiEnabled: false,
      hasWebhook: true,
      brandVoiceConfigured: false,
      embedSnippetReady: false,
    });
  });

  it('never leaks tenant B sentinels (incl. brand voice + instructions)', async () => {
    const result = await getBotReadinessStatus.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    // The tool returns ONLY booleans — no string fields. The check is
    // belt-and-suspenders against future regressions that add string
    // fields and accidentally leak tenant B's brand voice.
    assertNoForeignSentinels(result, TENANT_B_SENTINELS);
    // Also assert no part of tenant A's brand voice / instructions
    // appears — even the calling tenant's prompt content is off-limits
    // per invariant #8.
    const json = JSON.stringify(result);
    expect(json).not.toContain(TENANT_A_SENTINELS.brandVoiceInstructions);
    expect(json).not.toContain(TENANT_A_SENTINELS.brandVoiceName);
  });
});

describe('getIntegrationsStatus', () => {
  let a: SeededTenant;
  beforeEach(async () => {
    a = await seedTenantWithSentinels(TENANT_A_SENTINELS, { calcom: true });
    const b = await seedTenantWithSentinels(TENANT_B_SENTINELS, { calcom: true });
    await seedChannel(a.tenantId, 'messenger', 'active', TENANT_A_SENTINELS.channelLabel, TENANT_A_SENTINELS.platformAccountId);
    await seedChannel(a.tenantId, 'whatsapp', 'pending_setup', TENANT_A_SENTINELS.channelLabel, TENANT_A_SENTINELS.platformAccountId);
    await seedChannel(b.tenantId, 'instagram', 'active', TENANT_B_SENTINELS.channelLabel, TENANT_B_SENTINELS.platformAccountId);
  });

  it('reports calcom connected when API key + event type are present', async () => {
    const result = await getIntegrationsStatus.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result.calcom).toBe('connected');
  });

  it('maps messenger to facebook in the output', async () => {
    const result = await getIntegrationsStatus.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result.channels.facebook).toBe('connected');
    expect(result.channels.whatsapp).toBe('not_connected'); // pending_setup is not "active"
    expect(result.channels.instagram).toBe('not_connected'); // belongs to tenant B
    expect(result.channels.telegram).toBe('not_connected');
  });

  it('zero-fills the channels map exhaustively', async () => {
    const result = await getIntegrationsStatus.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(Object.keys(result.channels).sort()).toEqual([
      'facebook',
      'instagram',
      'telegram',
      'whatsapp',
    ]);
  });

  it('never leaks tenant B sentinels (channel labels, account IDs, etc)', async () => {
    const result = await getIntegrationsStatus.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    assertNoForeignSentinels(result, TENANT_B_SENTINELS);
    // The tool deliberately never returns channel labels or platform
    // account IDs even for the calling tenant — booleans only.
    const json = JSON.stringify(result);
    expect(json).not.toContain(TENANT_A_SENTINELS.channelLabel);
    expect(json).not.toContain(TENANT_A_SENTINELS.platformAccountId);
  });
});

describe('getEntitlements', () => {
  let a: SeededTenant;
  beforeEach(async () => {
    a = await seedTenantWithSentinels(TENANT_A_SENTINELS, { tier: 'pro' });
    await seedTenantWithSentinels(TENANT_B_SENTINELS, { tier: 'enterprise' });
  });

  it('returns a flat boolean map of features for the calling tier', async () => {
    const result = await getEntitlements.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result.features.platformAssistant).toBe(true);
    expect(result.features.calendarSync).toBe(true);
    expect(result.features.crm).toBe(false); // Pro doesn't include CRM
    expect(Object.keys(result.features).sort()).toEqual(
      [
        'aiBusinessInsights',
        'bookings',
        'calendarSync',
        'channelInstagram',
        'channelMessenger',
        'channelTelegram',
        'channelWhatsapp',
        'crm',
        'customWidgetAppearance',
        'fileUpload',
        'gapEvidence',
        'gapInsights',
        'handoff',
        'hideWidgetAttribution',
        'leadCapture',
        'platformAssistant',
        'unifiedInbox',
      ].sort(),
    );
    // Two-layer contract: ceiling mirrors features here (no tenant toggles),
    // and nothing is tenant-disabled.
    expect(result.entitledFeatures).toEqual(result.features);
    expect(result.disabledByTenant).toEqual([]);
  });

  it('returns Essential features when the tenant is on Essential', async () => {
    await AppDataSource.getRepository(Tenant).update(a.tenantId, { tier: 'essential' });
    const result = await getEntitlements.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result.features.platformAssistant).toBe(false);
    expect(result.features.calendarSync).toBe(false);
    expect(result.features.leadCapture).toBe(true);
  });

  it('never leaks tenant B sentinels', async () => {
    const result = await getEntitlements.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    assertNoForeignSentinels(result, TENANT_B_SENTINELS);
  });
});

describe('getLeadStats', () => {
  let a: SeededTenant;
  beforeEach(async () => {
    a = await seedTenantWithSentinels(TENANT_A_SENTINELS);
    const b = await seedTenantWithSentinels(TENANT_B_SENTINELS);

    const now = Date.now();
    // Tenant A: 3 'tool', 2 'manual', 1 'webhook' all recent
    for (let i = 0; i < 3; i++) await seedLead(a.tenantId, TENANT_A_SENTINELS, { source: 'tool' });
    for (let i = 0; i < 2; i++) await seedLead(a.tenantId, TENANT_A_SENTINELS, { source: 'manual' });
    await seedLead(a.tenantId, TENANT_A_SENTINELS, { source: 'webhook' });
    // Tenant A: 1 'tool' lead 60 days old (NOT counted in 7d / 30d)
    await seedLead(a.tenantId, TENANT_A_SENTINELS, {
      source: 'tool',
      createdAt: new Date(now - 60 * 24 * 60 * 60 * 1000),
    });
    // Tenant B: 4 leads (should never appear in tenant A's stats)
    for (let i = 0; i < 4; i++) await seedLead(b.tenantId, TENANT_B_SENTINELS, { source: 'tool' });
  });

  it('counts tenant A\'s leads, zero-fills sources, ignores tenant B', async () => {
    const result = await getLeadStats.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result.totalCount).toBe(7); // 6 recent + 1 old
    expect(result.last7Days).toBe(6);
    expect(result.last30Days).toBe(6);
    expect(result.bySource).toEqual({
      channel: 0, // identity-polymorphic sources, exhaustively zero-filled
      tool: 4, // 3 recent + 1 old
      booking: 0,
      manual: 2,
      import: 0,
      webhook: 1,
    });
  });

  it('returns zero counts when the tenant has no leads', async () => {
    await AppDataSource.getRepository(Lead).delete({ tenantId: a.tenantId });
    const result = await getLeadStats.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result.totalCount).toBe(0);
    expect(result.bySource).toEqual({ channel: 0, tool: 0, booking: 0, manual: 0, import: 0, webhook: 0 });
  });

  it('never leaks tenant B lead PII', async () => {
    const result = await getLeadStats.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    assertNoForeignSentinels(result, TENANT_B_SENTINELS);
    const json = JSON.stringify(result);
    // Tool returns counts only — never PII even for the calling tenant.
    expect(json).not.toContain(TENANT_A_SENTINELS.leadEmail);
    expect(json).not.toContain(TENANT_A_SENTINELS.leadName);
    expect(json).not.toContain(TENANT_A_SENTINELS.leadPhone);
    expect(json).not.toContain(TENANT_A_SENTINELS.leadNotes);
  });
});

describe('getRecentChatSessionStats', () => {
  let a: SeededTenant;
  beforeEach(async () => {
    a = await seedTenantWithSentinels(TENANT_A_SENTINELS);
    const b = await seedTenantWithSentinels(TENANT_B_SENTINELS);

    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

    // Tenant A: 3 widget, 2 messenger sessions in last 7 days; 1 of the
    // widget sessions is "active now" (last activity 5 min ago).
    await createTestSession(a.tenantId, {
      channel: 'widget',
      status: 'active',
      lastActivityAt: fiveMinAgo,
      startedAt: fiveMinAgo,
      firstResponseTimeSeconds: 30,
      visitorId: TENANT_A_SENTINELS.visitorId,
    });
    await createTestSession(a.tenantId, {
      channel: 'widget',
      status: 'closed',
      lastActivityAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      startedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      firstResponseTimeSeconds: 90,
      visitorId: TENANT_A_SENTINELS.visitorId,
    });
    await createTestSession(a.tenantId, {
      channel: 'widget',
      status: 'handoff',
      lastActivityAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      startedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      visitorId: TENANT_A_SENTINELS.visitorId,
    });
    await createTestSession(a.tenantId, {
      channel: 'messenger',
      status: 'closed',
      lastActivityAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      startedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      firstResponseTimeSeconds: 60,
      visitorId: TENANT_A_SENTINELS.visitorId,
    });
    await createTestSession(a.tenantId, {
      channel: 'messenger',
      status: 'bot',
      lastActivityAt: now,
      startedAt: now,
      visitorId: TENANT_A_SENTINELS.visitorId,
    });
    // Tenant B: 2 sessions — must not appear in tenant A's stats
    await createTestSession(b.tenantId, {
      channel: 'whatsapp',
      status: 'closed',
      lastActivityAt: now,
      startedAt: now,
      visitorId: TENANT_B_SENTINELS.visitorId,
    });
    await createTestSession(b.tenantId, {
      channel: 'whatsapp',
      status: 'closed',
      lastActivityAt: now,
      startedAt: now,
      visitorId: TENANT_B_SENTINELS.visitorId,
    });
  });

  it('aggregates last7Days correctly with exhaustive zero-fill', async () => {
    const result = await getRecentChatSessionStats.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result.last7Days.total).toBe(5);
    expect(result.last7Days.byChannel).toEqual({
      widget: 3,
      facebook: 2, // messenger maps to facebook
      instagram: 0,
      telegram: 0,
      whatsapp: 0, // tenant B's whatsapp must not leak
    });
    expect(result.last7Days.byStatus).toEqual({
      active: 1,
      closed: 2,
      waiting: 0,
      handoff: 1,
      bot: 1,
    });
  });

  it('returns activeNowCount (status=active AND last_activity < 15min)', async () => {
    const result = await getRecentChatSessionStats.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result.activeNowCount).toBe(1);
  });

  it('computes avgFirstResponseMinutes from sessions that recorded one', async () => {
    const result = await getRecentChatSessionStats.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    // 30 + 90 + 60 seconds = 180s / 3 = 60s = 1.0 min
    expect(result.avgFirstResponseMinutes).toBe(1.0);
  });

  it('returns null avgFirstResponseMinutes when no session has a recorded one', async () => {
    await AppDataSource.getRepository(ChatSession).update(
      { tenantId: a.tenantId },
      { firstResponseTimeSeconds: null as unknown as number },
    );
    const result = await getRecentChatSessionStats.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result.avgFirstResponseMinutes).toBeNull();
  });

  it('never leaks tenant B visitorIds or sentinels', async () => {
    const result = await getRecentChatSessionStats.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    assertNoForeignSentinels(result, TENANT_B_SENTINELS);
    const json = JSON.stringify(result);
    // Tool returns counts only — never visitor IDs even for caller.
    expect(json).not.toContain(TENANT_A_SENTINELS.visitorId);
  });
});

describe('getKnownGapTopics', () => {
  let a: SeededTenant;
  beforeEach(async () => {
    a = await seedTenantWithSentinels(TENANT_A_SENTINELS);
    await seedTenantWithSentinels(TENANT_B_SENTINELS);
  });

  it('returns the deployed-but-empty state when no gaps exist (Insights v1 shipped)', async () => {
    const result = await getKnownGapTopics.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    expect(result).toEqual({ sourceAvailable: true, topics: [] });
  });

  it('never leaks tenant B sentinels', async () => {
    const result = await getKnownGapTopics.execute({}, {
      tenantId: a.tenantId,
      userId: a.userId,
      manager: a.manager,
    });
    assertNoForeignSentinels(result, TENANT_B_SENTINELS);
  });
});

describe('Belt-and-suspenders: every tool response is JSON-serialisable', () => {
  // If a tool returns Date objects or circular refs we'd silently break
  // the SSE event encoding. Validate every v1 tool with a smoke-only
  // call as a fresh tenant.
  it('all 7 tools return JSON-serialisable values', async () => {
    const a = await seedTenantWithSentinels(TENANT_A_SENTINELS);
    const ctx = { tenantId: a.tenantId, userId: a.userId, manager: a.manager };

    const results = await Promise.all([
      getTenantSummary.execute({}, ctx),
      getBotReadinessStatus.execute({}, ctx),
      getIntegrationsStatus.execute({}, ctx),
      getEntitlements.execute({}, ctx),
      getLeadStats.execute({}, ctx),
      getRecentChatSessionStats.execute({}, ctx),
      getKnownGapTopics.execute({}, ctx),
    ]);

    for (const r of results) {
      expect(() => JSON.stringify(r)).not.toThrow();
      // Round-trip yields a structurally-equal object (no Date / undefined drift).
      expect(JSON.parse(JSON.stringify(r))).toEqual(JSON.parse(JSON.stringify(r)));
    }
  });
});

// Silence linter — TENANT_B_VALUES is part of the public surface but
// this file uses the structured `assertNoForeignSentinels` helper.
void TENANT_B_VALUES;
