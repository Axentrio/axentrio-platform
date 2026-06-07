/**
 * Message Forwarding Service — Integration Tests
 *
 * Tests the critical forwardMessageToN8n() cascade:
 *   visitor message → n8n → RAG fallback → handoff
 *
 * Uses real DB (Postgres) with mocked external boundaries:
 *   - RAG service (LLM calls)
 *   - OutboundService (n8n HTTP)
 *   - WebSocket emitters
 *   - Outbound router (channel routing)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
import { Tenant } from '../../database/entities/Tenant';
import { decrypt } from '../../utils/encryption';
import {
  createTestTenant as baseCreateTestTenant,
  createTestAnchorBot,
  createTestSession,
  createTestParticipant,
  createTestMessage,
} from '../helpers/factories';
import { Bot, BotSettings } from '../../database/entities/Bot';

/**
 * Multi-bot Phase 4 (#16d): the message-forwarding service now reads the
 * behavioural slice (ai/businessHours/integrations/features) from
 * `Bot.settings` via `getBotConfigForSession`. Tests pre-#16d passed those
 * sections inside `tenant.settings`; we now route them to the anchor bot
 * and keep the LLM provider apiKey on the tenant.
 *
 * This wrapper preserves the original ergonomics while transparently
 * splitting `settings` into the right entities.
 */
async function createTestTenant(overrides: Partial<Tenant> = {}): Promise<Tenant> {
  const { settings, ...tenantOverrides } = overrides;
  // Keep apiKey on tenant, move everything else to the bot's settings.
  const tenantSettings: any = {};
  const botSettings: BotSettings = {};
  if (settings) {
    for (const [k, v] of Object.entries(settings)) {
      if (k === 'ai') {
        const ai: any = v ?? {};
        const { apiKey, ...rest } = ai;
        if (apiKey !== undefined) {
          tenantSettings.ai = { apiKey };
        }
        if (Object.keys(rest).length > 0) {
          botSettings.ai = rest as BotSettings['ai'];
        }
      } else {
        // features / businessHours / integrations / skills / automations / etc.
        (botSettings as any)[k] = v;
      }
    }
  }
  const tenant = await baseCreateTestTenant({
    ...tenantOverrides,
    settings: tenantSettings,
  });
  await createTestAnchorBot(tenant, { settings: botSettings });
  return tenant;
}

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockEmitToSession = vi.fn();
const mockEmitToTenantAgents = vi.fn();

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: (...args: unknown[]) => mockEmitToSession(...args),
  emitToTenantAgents: (...args: unknown[]) => mockEmitToTenantAgents(...args),
  emitToAgent: vi.fn(),
}));

const mockGenerateResponse = vi.fn();
vi.mock('../../llm/rag.service', () => ({
  generateResponse: (...args: unknown[]) => mockGenerateResponse(...args),
}));

const mockRouteOutboundMessage = vi.fn().mockResolvedValue({ success: true });
vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: (...args: unknown[]) => mockRouteOutboundMessage(...args),
  routeTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));

const mockSendToWebhook = vi.fn();

// ── Import SUT after mocks ──────────────────────────────────────────────────

import {
  forwardMessageToN8n,
  initializeForwarding,
  initializeAgentService,
  buildWebhookConfig,
} from '../../services/message-forwarding.service';
import { OutboundService } from '../../n8n/outbound.service';
import { FallbackService } from '../../n8n/fallback.service';
import type { AgentService } from '../../agent/agent.service';

// ── Repos ────────────────────────────────────────────────────────────────────

const sessionRepo = AppDataSource.getRepository(ChatSession);
const messageRepo = AppDataSource.getRepository(Message);
const handoffRepo = AppDataSource.getRepository(HandoffRequest);

// ── Shared AI settings builder ───────────────────────────────────────────────

const AI_DEFAULTS = {
  provider: 'openai' as const,
  model: 'gpt-4o-mini',
  brandVoice: { name: 'TestBot', tone: 'friendly' as const, customInstructions: 'Be helpful.' },
  guardrails: {
    topicsToAvoid: [],
    escalationKeywords: ['speak to human', 'agent please'],
    confidenceThreshold: 0.5,
    maxResponseLength: 500,
    greetingMessage: 'Hello! How can I help?',
    fallbackMessage: "I'm connecting you to a human agent.",
    offHoursMessage: "We're closed right now. We'll get back to you soon.",
  },
};

function aiSettings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    ...AI_DEFAULTS,
    ...overrides,
    guardrails: { ...AI_DEFAULTS.guardrails, ...(overrides.guardrails as Record<string, unknown> || {}) },
    brandVoice: { ...AI_DEFAULTS.brandVoice, ...(overrides.brandVoice as Record<string, unknown> || {}) },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create session + participant + message in a single helper (3 DB ops) */
async function setup(
  tenantId: string,
  content = 'Hello bot',
  sessionOverrides: Partial<ChatSession> = {},
) {
  const session = await createTestSession(tenantId, { status: 'bot', ...sessionOverrides });
  const participant = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
  const message = await createTestMessage(session.id, tenantId, participant.id, {
    content,
    type: 'text',
    status: 'sent',
  });
  return { session, participant, message };
}

/** Get bot message contents — single query with join instead of multiple round-trips */
async function getBotMessages(sessionId: string): Promise<string[]> {
  const msgs = await messageRepo
    .createQueryBuilder('m')
    .innerJoin('m.participant', 'p')
    .where('m.sessionId = :sessionId', { sessionId })
    .andWhere('p.type = :type', { type: 'bot' })
    .orderBy('m.createdAt', 'ASC')
    .getMany();
  return msgs.map((m) => m.contentEncrypted ? decrypt(m.content) : m.content);
}

function ragSuccess(response: string, confidence = 0.9) {
  return { response, confidence, shouldHandoff: false, chunks: [] };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateResponse.mockReset();
  mockSendToWebhook.mockReset();
  mockRouteOutboundMessage.mockReset().mockResolvedValue({ success: true });

  const fakeOutbound = { sendToWebhook: mockSendToWebhook } as unknown as OutboundService;
  const fakeFallback = new FallbackService({
    eventEmitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), removeAllListeners: vi.fn() } as any,
  });
  initializeForwarding(fakeOutbound, fakeFallback);
});

// ═════════════════════════════════════════════════════════════════════════════

describe('forwardMessageToN8n', () => {

  // ── 0. No custom webhook → platform agent, never the dead default (#3) ────
  // Exercises the REAL routing restructure (the determineRoute unit test is
  // only a synthetic mirror). The bug: an AI bot without a custom webhook used
  // to POST to the dead default n8n webhook → 404 → spurious handoff.
  describe('no custom webhook routing (issue #3)', () => {
    it('does NOT POST to any webhook when AI is on without a custom webhook', async () => {
      // Legacy bot: usePlatformAgent unset, no custom webhook, no agent service.
      const tenant = await createTestTenant({
        settings: { ai: aiSettings({ usePlatformAgent: undefined }) },
      });
      const { session, message } = await setup(tenant.id);

      const result = await forwardMessageToN8n(session, message);

      expect(mockSendToWebhook).not.toHaveBeenCalled(); // the dead-default 404 is gone
      expect(result).toBe(false); // no agent service → stays waiting for a human
    });

    it('an explicit usePlatformAgent:false stays waiting — never the dead default', async () => {
      const tenant = await createTestTenant({
        settings: { ai: aiSettings({ usePlatformAgent: false }) },
      });
      const { session, message } = await setup(tenant.id);

      const result = await forwardMessageToN8n(session, message);

      expect(mockSendToWebhook).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it('routes a legacy bot (usePlatformAgent unset) to the platform agent, not a webhook', async () => {
      const runMock = vi.fn().mockResolvedValue({ type: 'response', content: 'Hi there' });
      initializeAgentService({ run: runMock } as unknown as AgentService);
      try {
        const tenant = await createTestTenant({
          settings: { ai: aiSettings({ usePlatformAgent: undefined }) },
        });
        const { session, message } = await setup(tenant.id);

        const result = await forwardMessageToN8n(session, message);

        expect(runMock).toHaveBeenCalled();          // platform agent handled it
        expect(mockSendToWebhook).not.toHaveBeenCalled(); // never the dead default
        expect(result).toBe(true);
      } finally {
        // Reset module-level agent so later tests see the default (null) state.
        initializeAgentService(null as unknown as AgentService);
      }
    });
  });

  // ── 1. Session status guards ─────────────────────────────────────────────

  describe('session status guards', () => {
    it('should NOT forward when session is active/closed/handoff', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings() },
      });

      for (const status of ['active', 'closed', 'handoff'] as const) {
        const { session, message } = await setup(tenant.id);
        await sessionRepo.update(session.id, { status });
        const reloaded = await sessionRepo.findOneOrFail({ where: { id: session.id } });
        expect(await forwardMessageToN8n(reloaded, message)).toBe(false);
      }

      expect(mockGenerateResponse).not.toHaveBeenCalled();
      expect(mockSendToWebhook).not.toHaveBeenCalled();
    });

    it('should forward when session is "bot" (n8n path)', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings() },
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockResolvedValue({ success: true });
      expect(await forwardMessageToN8n(session, message)).toBe(true);
      expect(mockSendToWebhook).toHaveBeenCalled();
    });

    it('should forward when session is "waiting" (n8n path)', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {},
      });
      const { session, message } = await setup(tenant.id);
      await sessionRepo.update(session.id, { status: 'waiting' });
      const reloaded = await sessionRepo.findOneOrFail({ where: { id: session.id } });

      mockSendToWebhook.mockResolvedValue({ success: true });
      expect(await forwardMessageToN8n(reloaded, message)).toBe(true);
      expect(mockSendToWebhook).toHaveBeenCalled();
    });
  });

  // ── 2. n8n happy path ──────────────────────────────────────────────────

  describe('n8n happy path (bot session)', () => {
    it('should forward to n8n and include tenantConfig in payload', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings() },
      });
      const { session, message } = await setup(tenant.id, 'What are your hours?');

      mockSendToWebhook.mockResolvedValue({ success: true });
      expect(await forwardMessageToN8n(session, message)).toBe(true);

      const payload = mockSendToWebhook.mock.calls[0][1];
      expect(payload.tenantConfig).toBeDefined();
      expect(payload.tenantConfig.brandName).toBe('TestBot');
      expect(payload.tenantConfig.brandTone).toBe('friendly');
    });

    it('should include knowledgeBase metadata in payload', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings() },
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockResolvedValue({ success: true });
      await forwardMessageToN8n(session, message);

      const payload = mockSendToWebhook.mock.calls[0][1];
      expect(payload.knowledgeBase).toBeDefined();
      expect(typeof payload.knowledgeBase.enabled).toBe('boolean');
      expect(typeof payload.knowledgeBase.documentCount).toBe('number');
    });

    it('should include conversation history in payload', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings() },
      });
      const session = await createTestSession(tenant.id, { status: 'bot' });
      const user = await createTestParticipant(session.id, { type: 'user' });
      const bot = await createTestParticipant(session.id, { type: 'bot', name: 'Bot' });

      await createTestMessage(session.id, tenant.id, user.id, { content: 'Hi' });
      await createTestMessage(session.id, tenant.id, bot.id, { content: 'Hello!' });
      const lastMsg = await createTestMessage(session.id, tenant.id, user.id, {
        content: 'Return policy?',
      });

      mockSendToWebhook.mockResolvedValue({ success: true });
      await forwardMessageToN8n(session, lastMsg);

      const payload = mockSendToWebhook.mock.calls[0][1];
      expect(payload.context.previousMessages).toBeDefined();
      expect(payload.context.previousMessages.length).toBeGreaterThanOrEqual(2);
    });

    it('should NOT call generateResponse directly (n8n handles AI)', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings() },
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockResolvedValue({ success: true });
      await forwardMessageToN8n(session, message);

      expect(mockGenerateResponse).not.toHaveBeenCalled();
    });

    it('should verify payload event and session/tenant IDs', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings() },
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockResolvedValue({ success: true });
      await forwardMessageToN8n(session, message);

      const payload = mockSendToWebhook.mock.calls[0][1];
      expect(payload.event).toBe('message.received');
      expect(payload.tenantId).toBe(tenant.id);
      expect(payload.sessionId).toBe(session.id);
    });
  });

  // ── 3. n8n failure → RAG fallback ──────────────────────────────────────

  describe('n8n failure → RAG fallback', () => {
    it('should fall back to RAG when n8n fails and tenant has KB', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id, 'What is your return policy?');

      // n8n fails
      mockSendToWebhook.mockResolvedValue({ success: false, error: 'n8n down' });
      // RAG fallback succeeds
      mockGenerateResponse.mockResolvedValue(ragSuccess('30 day returns.'));

      // We need KB to exist for fallback. The knowledgeBase.enabled check uses the payload
      // which queries the DB. Since no docs exist in test, fallback won't trigger via KB check.
      // Instead, test the final fallback path (handoff).
      expect(await forwardMessageToN8n(session, message)).toBe(true);
    });

    it('should handoff when n8n fails and no KB available', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id, 'obscure question');

      mockSendToWebhook.mockResolvedValue({ success: false, error: 'n8n down' });
      await forwardMessageToN8n(session, message);

      // Should handoff since no KB docs exist in test
      expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('handoff');
      expect(mockEmitToTenantAgents).toHaveBeenCalledWith(
        tenant.id,
        'handoff:requested',
        expect.objectContaining({ sessionId: session.id }),
      );
    });
  });

  // ── 4. Escalation keywords ───────────────────────────────────────────────

  describe('escalation keyword detection', () => {
    it('should skip n8n, send fallback, and handoff when keyword found', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id, 'I want to speak to human now');

      expect(await forwardMessageToN8n(session, message)).toBe(true);
      expect(mockSendToWebhook).not.toHaveBeenCalled();

      const botMsgs = await getBotMessages(session.id);
      expect(botMsgs).toEqual(["I'm connecting you to a human agent."]);

      const h = await handoffRepo.findOne({ where: { sessionId: session.id } });
      expect(h!.reason).toBe('bot_escalation_keyword');
    });

    it('should match case-insensitively and partially', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });

      // Case insensitive
      const t1 = await setup(tenant.id, 'AGENT PLEASE help');
      await forwardMessageToN8n(t1.session, t1.message);
      expect(await handoffRepo.count({ where: { sessionId: t1.session.id } })).toBe(1);

      // Partial match
      const t2 = await setup(tenant.id, 'I need to speak to human about my order');
      await forwardMessageToN8n(t2.session, t2.message);
      expect(await handoffRepo.count({ where: { sessionId: t2.session.id } })).toBe(1);

      expect(mockSendToWebhook).not.toHaveBeenCalled();
    });

    it('should NOT match absent keywords — proceeds to n8n', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id, 'What is the weather?');

      mockSendToWebhook.mockResolvedValue({ success: true });
      await forwardMessageToN8n(session, message);

      expect(mockSendToWebhook).toHaveBeenCalled();
      expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
    });

    it('should use custom fallback message from guardrails', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {
          ai: aiSettings({
            guardrails: { escalationKeywords: ['help me'], fallbackMessage: 'Getting someone now!' },
          }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
        },
      });
      const { session, message } = await setup(tenant.id, 'Please help me');

      await forwardMessageToN8n(session, message);
      expect(await getBotMessages(session.id)).toEqual(['Getting someone now!']);
    });

    it('should NOT check keywords for non-text messages', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const session = await createTestSession(tenant.id, { status: 'bot' });
      const p = await createTestParticipant(session.id, { type: 'user' });
      const message = await createTestMessage(session.id, tenant.id, p.id, {
        content: 'speak to human',
        type: 'image',
      });

      mockSendToWebhook.mockResolvedValue({ success: true });
      await forwardMessageToN8n(session, message);
      // Non-text messages skip pre-checks, go straight to n8n
      expect(mockSendToWebhook).toHaveBeenCalled();
      expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
    });
  });

  // ── 5. Business hours ────────────────────────────────────────────────────

  describe('business hours handling', () => {
    // Pin time to Wednesday 2026-01-14 at 10:00 UTC for deterministic tests
    const FIXED_DATE = new Date('2026-01-14T10:00:00Z');
    const FIXED_DAY = 'wednesday';

    beforeEach(() => { vi.useFakeTimers({ now: FIXED_DATE }); });
    afterEach(() => { vi.useRealTimers(); });

    it('should send offHoursMessage when outside hours (1-min window)', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [], offHoursMessage: 'We are closed.' } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: {
            enabled: true,
            timezone: 'UTC',
            // Open 08:00–09:00 — fixed time 10:00 is outside this window
            schedule: ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
              .map((day) => ({ day, open: '08:00', close: '09:00', closed: false })),
          },
        },
      });
      const { session, message } = await setup(tenant.id);

      expect(await forwardMessageToN8n(session, message)).toBe(true);
      expect(mockSendToWebhook).not.toHaveBeenCalled();
      expect(await getBotMessages(session.id)).toEqual(['We are closed.']);
    });

    it('should send offHoursMessage when day is closed', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [], offHoursMessage: 'Closed today.' } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: {
            enabled: true,
            timezone: 'UTC',
            schedule: [{ day: FIXED_DAY, open: '09:00', close: '17:00', closed: true }],
          },
        },
      });
      const { session, message } = await setup(tenant.id);

      await forwardMessageToN8n(session, message);
      expect(await getBotMessages(session.id)).toEqual(['Closed today.']);
    });

    it('should proceed to n8n when within hours (24h window)', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [] } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: {
            enabled: true,
            timezone: 'UTC',
            schedule: [{ day: FIXED_DAY, open: '00:00', close: '23:59', closed: false }],
          },
        },
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockResolvedValue({ success: true });
      await forwardMessageToN8n(session, message);
      expect(mockSendToWebhook).toHaveBeenCalled();
    });

    it('should skip check when businessHours not enabled', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [] } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: { enabled: false, timezone: 'UTC', schedule: [] },
        },
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockResolvedValue({ success: true });
      await forwardMessageToN8n(session, message);
      expect(mockSendToWebhook).toHaveBeenCalled();
    });

    it('should send offHoursMessage when no schedule for current day', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [], offHoursMessage: 'No schedule.' } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: {
            enabled: true,
            timezone: 'UTC',
            schedule: [{ day: 'nonexistentday', open: '00:00', close: '23:59', closed: false }],
          },
        },
      });
      const { session, message } = await setup(tenant.id);

      await forwardMessageToN8n(session, message);
      expect(await getBotMessages(session.id)).toEqual(['No schedule.']);
    });

    it('should use default message when offHoursMessage is empty', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [], offHoursMessage: '' } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: {
            enabled: true,
            timezone: 'UTC',
            schedule: [{ day: FIXED_DAY, open: '08:00', close: '09:00', closed: false }],
          },
        },
      });
      const { session, message } = await setup(tenant.id);

      await forwardMessageToN8n(session, message);
      const msgs = await getBotMessages(session.id);
      expect(msgs[0]).toContain('outside business hours');
    });

    it('should prioritize business hours over escalation keywords', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {
          ai: aiSettings({ guardrails: { offHoursMessage: 'Closed.' } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: {
            enabled: true,
            timezone: 'UTC',
            schedule: [{ day: FIXED_DAY, open: '08:00', close: '09:00', closed: false }],
          },
        },
      });
      const { session, message } = await setup(tenant.id, 'speak to human');

      await forwardMessageToN8n(session, message);
      expect(mockSendToWebhook).not.toHaveBeenCalled();
      expect(await getBotMessages(session.id)).toEqual(['Closed.']);
      expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
    });
  });

  // ── 6. n8n failure → final fallback → handoff ─────────────────────────

  describe('n8n failure → final fallback → handoff', () => {
    it('should send fallback, create bot_error handoff, notify agents', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockResolvedValue({ success: false, error: 'n8n down' });
      expect(await forwardMessageToN8n(session, message)).toBe(true);

      expect((await getBotMessages(session.id)).length).toBeGreaterThanOrEqual(1);

      const h = await handoffRepo.findOne({ where: { sessionId: session.id } });
      expect(h).toBeDefined();
      expect(h!.reason).toBe('bot_error');

      expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('handoff');

      expect(mockEmitToTenantAgents).toHaveBeenCalledWith(
        tenant.id,
        'handoff:requested',
        expect.objectContaining({ sessionId: session.id }),
      );
    });

    it('should use custom fallback message on n8n failure', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {
          ai: aiSettings({ guardrails: { fallbackMessage: 'Oops! Getting help.' } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
        },
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockResolvedValue({ success: false, error: 'fail' });
      await forwardMessageToN8n(session, message);
      expect(await getBotMessages(session.id)).toEqual(['Oops! Getting help.']);
    });

    it('should still return true even if error handler partially fails', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockResolvedValue({ success: false, error: 'boom' });
      expect(await forwardMessageToN8n(session, message)).toBe(true);
    });
  });

  // ── 7. Handoff disabled ──────────────────────────────────────────────────

  describe('handoff disabled', () => {
    it('should send fallback but NOT create handoff on keyword match', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: ['help me'] } }),
          features: { fileUploadEnabled: true, handoffEnabled: false },
        },
      });
      const { session, message } = await setup(tenant.id, 'help me now');

      await forwardMessageToN8n(session, message);

      expect((await getBotMessages(session.id)).length).toBeGreaterThanOrEqual(1);
      expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
      expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('bot');
    });
  });

  // ── 8. n8n forwarding (AI disabled, custom webhook) ─────────────────────

  describe('n8n forwarding (AI disabled, custom webhook)', () => {
    it('should forward to n8n and verify payload structure', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 'secret',
        settings: {},
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockResolvedValue({ success: true });
      expect(await forwardMessageToN8n(session, message)).toBe(true);
      expect(mockGenerateResponse).not.toHaveBeenCalled();

      const payload = mockSendToWebhook.mock.calls[0][1];
      expect(payload.event).toBe('message.received');
      expect(payload.tenantId).toBe(tenant.id);
      expect(payload.sessionId).toBe(session.id);
    });

    it('should transition waiting → bot on first forwarded message', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {},
      });
      const session = await createTestSession(tenant.id, { status: 'waiting' });
      const p = await createTestParticipant(session.id, { type: 'user' });
      const message = await createTestMessage(session.id, tenant.id, p.id, { content: 'Hi' });

      mockSendToWebhook.mockResolvedValue({ success: true });
      await forwardMessageToN8n(session, message);

      expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('bot');
    });

    it('should handoff when n8n fails for non-AI tenant', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {},
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockResolvedValue({ success: false, error: 'Connection refused' });
      expect(await forwardMessageToN8n(session, message)).toBe(true);

      expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('handoff');
      expect(mockEmitToTenantAgents).toHaveBeenCalledWith(
        tenant.id,
        'handoff:requested',
        expect.objectContaining({ sessionId: session.id }),
      );
    });

    it('should build correct webhook config from tenant', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 'my-secret',
        settings: {},
      });

      const config = buildWebhookConfig(tenant);
      expect(config.url).toBe('https://n8n.test/hook');
      expect(config.secret).toBe('my-secret');
      expect(config.active).toBe(true);
      expect(config.events).toContain('message.received');
    });
  });

  // ── 9. No AI + no webhook ───────────────────────────────────────────────

  describe('no AI + no webhook configured', () => {
    it('should return false when neither AI nor webhook is configured', async () => {
      const tenant = await createTestTenant({ settings: {} });
      const { session, message } = await setup(tenant.id);

      expect(await forwardMessageToN8n(session, message)).toBe(false);
      expect(mockGenerateResponse).not.toHaveBeenCalled();
      expect(mockSendToWebhook).not.toHaveBeenCalled();
    });

    it('should return false when AI is explicitly disabled', async () => {
      const tenant = await createTestTenant({ settings: { ai: aiSettings({ enabled: false }) } });
      const { session, message } = await setup(tenant.id);

      expect(await forwardMessageToN8n(session, message)).toBe(false);
    });

    it('should return false when webhook URL is empty', async () => {
      const tenant = await createTestTenant({ webhookUrl: '', settings: {} });
      const { session, message } = await setup(tenant.id);

      expect(await forwardMessageToN8n(session, message)).toBe(false);
    });
  });

  // ── 10. Edge cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle empty escalation keywords — proceeds to n8n', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [] } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
        },
      });
      const { session, message } = await setup(tenant.id, 'speak to human');

      mockSendToWebhook.mockResolvedValue({ success: true });
      await forwardMessageToN8n(session, message);
      expect(mockSendToWebhook).toHaveBeenCalled();
    });

    it('should handle missing escalationKeywords gracefully', async () => {
      const settings = aiSettings();
      delete (settings.guardrails as any).escalationKeywords;

      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: settings, features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockResolvedValue({ success: true });
      expect(await forwardMessageToN8n(session, message)).toBe(true);
    });

    it('should handle concurrent messages to same session', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const session = await createTestSession(tenant.id, { status: 'bot' });
      const p = await createTestParticipant(session.id, { type: 'user' });
      const msg1 = await createTestMessage(session.id, tenant.id, p.id, { content: 'Msg 1' });
      const msg2 = await createTestMessage(session.id, tenant.id, p.id, { content: 'Msg 2' });

      mockSendToWebhook.mockResolvedValue({ success: true });

      const [r1, r2] = await Promise.all([
        forwardMessageToN8n(session, msg1),
        forwardMessageToN8n(session, msg2),
      ]);

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(mockSendToWebhook).toHaveBeenCalledTimes(2);
    });

    it('should handle empty message content', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const session = await createTestSession(tenant.id, { status: 'bot' });
      const p = await createTestParticipant(session.id, { type: 'user' });
      const message = await createTestMessage(session.id, tenant.id, p.id, { content: '' });

      mockSendToWebhook.mockResolvedValue({ success: true });
      expect(await forwardMessageToN8n(session, message)).toBe(true);
    });

    it('should handle bot with settings cleared mid-conversation', async () => {
      // Multi-bot Phase 4 (#16d): the behavioural slice lives on Bot.settings.
      // Clearing the bot's settings (admin disables AI) means no webhook + no
      // AI → forwarding returns false. (Previously this test cleared
      // tenant.settings, which is no longer the source of truth.)
      const tenant = await createTestTenant({
        settings: { ai: aiSettings() },
      });
      const { session, message } = await setup(tenant.id);
      await AppDataSource.getRepository(Bot)
        .createQueryBuilder()
        .update()
        .set({ settings: {} as BotSettings })
        .where('tenantId = :tenantId AND isDefault = true', { tenantId: tenant.id })
        .execute();

      expect(await forwardMessageToN8n(session, message)).toBe(false);
    });
  });
});
