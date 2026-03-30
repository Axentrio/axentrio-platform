/**
 * Message Forwarding Service — Integration Tests
 *
 * Tests the critical forwardMessageToN8n() cascade:
 *   visitor message → RAG → n8n → fallback → handoff
 *
 * Uses real DB (Postgres) with mocked external boundaries:
 *   - RAG service (LLM calls)
 *   - OutboundService (n8n HTTP)
 *   - WebSocket emitters
 *   - Outbound router (channel routing)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { Participant } from '../../database/entities/Participant';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
import { Tenant } from '../../database/entities/Tenant';
import {
  createTestTenant,
  createTestSession,
  createTestParticipant,
  createTestMessage,
} from '../helpers/factories';

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
  buildWebhookConfig,
} from '../../services/message-forwarding.service';
import { OutboundService } from '../../n8n/outbound.service';
import { FallbackService } from '../../n8n/fallback.service';

// ── Repos ────────────────────────────────────────────────────────────────────

const sessionRepo = AppDataSource.getRepository(ChatSession);
const messageRepo = AppDataSource.getRepository(Message);
const participantRepo = AppDataSource.getRepository(Participant);
const handoffRepo = AppDataSource.getRepository(HandoffRequest);
const tenantRepo = AppDataSource.getRepository(Tenant);

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
  return msgs.map((m) => m.content);
}

function ragSuccess(response: string, confidence = 0.9) {
  return { response, confidence, shouldHandoff: false, chunks: [] };
}

function ragHandoff(response: string, reason: string, confidence = 0.2) {
  return { response, confidence, shouldHandoff: true, handoffReason: reason, chunks: [] };
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

  // ── 1. Session status guards ─────────────────────────────────────────────

  describe('session status guards', () => {
    it('should NOT forward when session is active/closed/handoff', async () => {
      const tenant = await createTestTenant({ settings: { ai: aiSettings() } });

      for (const status of ['active', 'closed', 'handoff'] as const) {
        const { session, message } = await setup(tenant.id);
        await sessionRepo.update(session.id, { status });
        const reloaded = await sessionRepo.findOneOrFail({ where: { id: session.id } });
        expect(await forwardMessageToN8n(reloaded, message)).toBe(false);
      }

      expect(mockGenerateResponse).not.toHaveBeenCalled();
      expect(mockSendToWebhook).not.toHaveBeenCalled();
    });

    it('should forward when session is "bot" (RAG path)', async () => {
      const tenant = await createTestTenant({ settings: { ai: aiSettings() } });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockResolvedValue(ragSuccess('Hello!'));
      expect(await forwardMessageToN8n(session, message)).toBe(true);
      expect(mockGenerateResponse).toHaveBeenCalled();
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

  // ── 2. RAG happy path ────────────────────────────────────────────────────

  describe('RAG happy path', () => {
    it('should call generateResponse and save bot message to DB', async () => {
      const tenant = await createTestTenant({ settings: { ai: aiSettings() } });
      const { session, message } = await setup(tenant.id, 'What are your hours?');

      mockGenerateResponse.mockResolvedValue(ragSuccess('We are open 9-5 Monday to Friday.', 0.95));
      expect(await forwardMessageToN8n(session, message)).toBe(true);

      const botMsgs = await getBotMessages(session.id);
      expect(botMsgs).toEqual(['We are open 9-5 Monday to Friday.']);
    });

    it('should NOT trigger handoff and session stays bot', async () => {
      const tenant = await createTestTenant({ settings: { ai: aiSettings() } });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockResolvedValue(ragSuccess('Info here.'));
      await forwardMessageToN8n(session, message);

      expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
      expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('bot');
    });

    it('should route bot message via outbound router', async () => {
      const tenant = await createTestTenant({ settings: { ai: aiSettings() } });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockResolvedValue(ragSuccess('Router test'));
      await forwardMessageToN8n(session, message);

      expect(mockRouteOutboundMessage).toHaveBeenCalledWith(
        { type: 'text', content: 'Router test' },
        expect.objectContaining({ sessionId: session.id, tenantId: tenant.id }),
        expect.objectContaining({
          event: 'message:receive',
          data: expect.objectContaining({ content: 'Router test', senderType: 'bot' }),
        }),
      );
    });

    it('should create bot participant with brandVoice name, and reuse on second call', async () => {
      const tenant = await createTestTenant({ settings: { ai: aiSettings() } });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockResolvedValue(ragSuccess('Hi'));
      await forwardMessageToN8n(session, message);

      const bots = await participantRepo.find({ where: { sessionId: session.id, type: 'bot' } });
      expect(bots).toHaveLength(1);
      expect(bots[0].name).toBe('TestBot');

      // Second message — should reuse same participant
      const msg2 = await createTestMessage(session.id, tenant.id, bots[0].id, { content: 'Again' });
      mockGenerateResponse.mockResolvedValue(ragSuccess('Hi again'));
      await forwardMessageToN8n(session, msg2);

      expect(await participantRepo.count({ where: { sessionId: session.id, type: 'bot' } })).toBe(1);
    });

    it('should pass conversation history to generateResponse', async () => {
      const tenant = await createTestTenant({ settings: { ai: aiSettings() } });
      const session = await createTestSession(tenant.id, { status: 'bot' });
      const user = await createTestParticipant(session.id, { type: 'user' });
      const bot = await createTestParticipant(session.id, { type: 'bot', name: 'Bot' });

      await createTestMessage(session.id, tenant.id, user.id, { content: 'Hi' });
      await createTestMessage(session.id, tenant.id, bot.id, { content: 'Hello!' });
      const lastMsg = await createTestMessage(session.id, tenant.id, user.id, {
        content: 'Return policy?',
      });

      mockGenerateResponse.mockResolvedValue(ragSuccess('30 days.'));
      await forwardMessageToN8n(session, lastMsg);

      const [, , , customerMessage, history] = mockGenerateResponse.mock.calls[0];
      expect(customerMessage).toBe('Return policy?');
      expect(history.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── 3. RAG low confidence → handoff ──────────────────────────────────────

  describe('RAG low confidence → handoff', () => {
    it('should create handoff, change session status, and notify agents', async () => {
      const tenant = await createTestTenant({
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id, 'obscure question');

      mockGenerateResponse.mockResolvedValue(ragHandoff('Connecting you.', 'bot_confidence_low'));
      await forwardMessageToN8n(session, message);

      // Bot message saved
      expect((await getBotMessages(session.id)).length).toBe(1);

      // Handoff created
      const handoffs = await handoffRepo.find({ where: { sessionId: session.id } });
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0].reason).toBe('bot_confidence_low');
      expect(handoffs[0].status).toBe('requested');

      // Session → handoff
      expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('handoff');

      // Agents notified
      expect(mockEmitToTenantAgents).toHaveBeenCalledWith(
        tenant.id,
        'handoff:requested',
        expect.objectContaining({ sessionId: session.id, reason: 'bot_confidence_low' }),
      );
    });

    it('should trigger handoff with bot_no_knowledge reason', async () => {
      const tenant = await createTestTenant({
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockResolvedValue(ragHandoff('No answer.', 'bot_no_knowledge', 0));
      await forwardMessageToN8n(session, message);

      const h = await handoffRepo.findOne({ where: { sessionId: session.id } });
      expect(h!.reason).toBe('bot_no_knowledge');
    });
  });

  // ── 4. Escalation keywords ───────────────────────────────────────────────

  describe('escalation keyword detection', () => {
    it('should skip RAG, send fallback, and handoff when keyword found', async () => {
      const tenant = await createTestTenant({
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id, 'I want to speak to human now');

      expect(await forwardMessageToN8n(session, message)).toBe(true);
      expect(mockGenerateResponse).not.toHaveBeenCalled();

      const botMsgs = await getBotMessages(session.id);
      expect(botMsgs).toEqual(["I'm connecting you to a human agent."]);

      const h = await handoffRepo.findOne({ where: { sessionId: session.id } });
      expect(h!.reason).toBe('bot_escalation_keyword');
    });

    it('should match case-insensitively and partially', async () => {
      const tenant = await createTestTenant({
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

      expect(mockGenerateResponse).not.toHaveBeenCalled();
    });

    it('should NOT match absent keywords — proceeds to RAG', async () => {
      const tenant = await createTestTenant({
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id, 'What is the weather?');

      mockGenerateResponse.mockResolvedValue(ragSuccess('Cannot check weather.'));
      await forwardMessageToN8n(session, message);

      expect(mockGenerateResponse).toHaveBeenCalled();
      expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
    });

    it('should use custom fallback message from guardrails', async () => {
      const tenant = await createTestTenant({
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
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const session = await createTestSession(tenant.id, { status: 'bot' });
      const p = await createTestParticipant(session.id, { type: 'user' });
      const message = await createTestMessage(session.id, tenant.id, p.id, {
        content: 'speak to human',
        type: 'image',
      });

      expect(await forwardMessageToN8n(session, message)).toBe(false);
      expect(mockGenerateResponse).not.toHaveBeenCalled();
    });
  });

  // ── 5. Business hours ────────────────────────────────────────────────────

  describe('business hours handling', () => {
    const today = (() => {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' });
      return f.format(new Date()).toLowerCase();
    })();

    it('should send offHoursMessage when outside hours (1-min window)', async () => {
      const tenant = await createTestTenant({
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [], offHoursMessage: 'We are closed.' } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: {
            enabled: true,
            timezone: 'UTC',
            // 1-minute window at midnight — will always be outside hours
            schedule: ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
              .map((day) => ({ day, open: '00:00', close: '00:01', closed: false })),
          },
        },
      });
      const { session, message } = await setup(tenant.id);

      expect(await forwardMessageToN8n(session, message)).toBe(true);
      expect(mockGenerateResponse).not.toHaveBeenCalled();
      expect(await getBotMessages(session.id)).toEqual(['We are closed.']);
    });

    it('should send offHoursMessage when day is closed', async () => {
      const tenant = await createTestTenant({
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [], offHoursMessage: 'Closed today.' } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: {
            enabled: true,
            timezone: 'UTC',
            schedule: [{ day: today, open: '09:00', close: '17:00', closed: true }],
          },
        },
      });
      const { session, message } = await setup(tenant.id);

      await forwardMessageToN8n(session, message);
      expect(await getBotMessages(session.id)).toEqual(['Closed today.']);
    });

    it('should proceed to RAG when within hours (24h window)', async () => {
      const tenant = await createTestTenant({
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [] } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: {
            enabled: true,
            timezone: 'UTC',
            schedule: [{ day: today, open: '00:00', close: '23:59', closed: false }],
          },
        },
      });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockResolvedValue(ragSuccess('Within hours'));
      await forwardMessageToN8n(session, message);
      expect(mockGenerateResponse).toHaveBeenCalled();
    });

    it('should skip check when businessHours not enabled', async () => {
      const tenant = await createTestTenant({
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [] } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: { enabled: false, timezone: 'UTC', schedule: [] },
        },
      });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockResolvedValue(ragSuccess('OK'));
      await forwardMessageToN8n(session, message);
      expect(mockGenerateResponse).toHaveBeenCalled();
    });

    it('should send offHoursMessage when no schedule for current day', async () => {
      const tenant = await createTestTenant({
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
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [], offHoursMessage: '' } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: {
            enabled: true,
            timezone: 'UTC',
            schedule: [{ day: today, open: '00:00', close: '00:01', closed: false }],
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
        settings: {
          ai: aiSettings({ guardrails: { offHoursMessage: 'Closed.' } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
          businessHours: {
            enabled: true,
            timezone: 'UTC',
            schedule: [{ day: today, open: '00:00', close: '00:01', closed: false }],
          },
        },
      });
      const { session, message } = await setup(tenant.id, 'speak to human');

      await forwardMessageToN8n(session, message);
      expect(mockGenerateResponse).not.toHaveBeenCalled();
      expect(await getBotMessages(session.id)).toEqual(['Closed.']);
      expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
    });
  });

  // ── 6. RAG error → handoff ──────────────────────────────────────────────

  describe('RAG error → fallback → handoff', () => {
    it('should send fallback, create bot_error handoff, notify agents', async () => {
      const tenant = await createTestTenant({
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockRejectedValue(new Error('OpenAI rate limit'));
      expect(await forwardMessageToN8n(session, message)).toBe(true);

      expect(await getBotMessages(session.id)).toEqual(["I'm connecting you to a human agent."]);

      const h = await handoffRepo.findOne({ where: { sessionId: session.id } });
      expect(h!.reason).toBe('bot_error');

      expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('handoff');

      expect(mockEmitToTenantAgents).toHaveBeenCalledWith(
        tenant.id,
        'handoff:requested',
        expect.objectContaining({ sessionId: session.id, reason: 'bot_error' }),
      );
    });

    it('should use custom fallback message on error', async () => {
      const tenant = await createTestTenant({
        settings: {
          ai: aiSettings({ guardrails: { fallbackMessage: 'Oops! Getting help.' } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
        },
      });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockRejectedValue(new Error('fail'));
      await forwardMessageToN8n(session, message);
      expect(await getBotMessages(session.id)).toEqual(['Oops! Getting help.']);
    });

    it('should still return true even if error handler partially fails', async () => {
      const tenant = await createTestTenant({
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockRejectedValue(new Error('boom'));
      expect(await forwardMessageToN8n(session, message)).toBe(true);
    });
  });

  // ── 7. Handoff disabled ──────────────────────────────────────────────────

  describe('handoff disabled', () => {
    it('should send fallback but NOT create handoff on keyword match', async () => {
      const tenant = await createTestTenant({
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

    it('should send fallback but NOT handoff on low RAG confidence', async () => {
      const tenant = await createTestTenant({
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [] } }),
          features: { fileUploadEnabled: true, handoffEnabled: false },
        },
      });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockResolvedValue(ragHandoff("Don't know.", 'bot_confidence_low'));
      await forwardMessageToN8n(session, message);

      expect(await handoffRepo.count({ where: { sessionId: session.id } })).toBe(0);
      expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('bot');
    });
  });

  // ── 8. n8n forwarding (AI disabled) ──────────────────────────────────────

  describe('n8n forwarding (AI disabled)', () => {
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

    it('should handoff and notify agents when n8n fails', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {},
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockRejectedValue(new Error('Connection refused'));
      expect(await forwardMessageToN8n(session, message)).toBe(true);

      expect((await sessionRepo.findOneOrFail({ where: { id: session.id } })).status).toBe('handoff');
      expect(mockEmitToTenantAgents).toHaveBeenCalledWith(
        tenant.id,
        'handoff:requested',
        expect.objectContaining({ sessionId: session.id, reason: 'n8n_unavailable' }),
      );
    });

    it('should emit fallback system message when n8n fails', async () => {
      const tenant = await createTestTenant({
        webhookUrl: 'https://n8n.test/hook',
        webhookSecret: 's',
        settings: {},
      });
      const { session, message } = await setup(tenant.id);

      mockSendToWebhook.mockRejectedValue(new Error('Timeout'));
      await forwardMessageToN8n(session, message);

      expect(mockEmitToSession).toHaveBeenCalledWith(
        tenant.id,
        session.id,
        'message:receive',
        expect.objectContaining({
          type: 'system',
          content: expect.stringContaining('connecting you to an agent'),
        }),
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
    it('should handle empty escalation keywords — proceeds to RAG', async () => {
      const tenant = await createTestTenant({
        settings: {
          ai: aiSettings({ guardrails: { escalationKeywords: [] } }),
          features: { fileUploadEnabled: true, handoffEnabled: true },
        },
      });
      const { session, message } = await setup(tenant.id, 'speak to human');

      mockGenerateResponse.mockResolvedValue(ragSuccess('Normal response'));
      await forwardMessageToN8n(session, message);
      expect(mockGenerateResponse).toHaveBeenCalled();
    });

    it('should handle missing escalationKeywords gracefully', async () => {
      const settings = aiSettings();
      delete (settings.guardrails as any).escalationKeywords;

      const tenant = await createTestTenant({
        settings: { ai: settings, features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockResolvedValue(ragSuccess('OK'));
      expect(await forwardMessageToN8n(session, message)).toBe(true);
    });

    it('should handle shouldHandoff without handoffReason', async () => {
      const tenant = await createTestTenant({
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const { session, message } = await setup(tenant.id);

      mockGenerateResponse.mockResolvedValue({
        response: 'Some response',
        confidence: 0.3,
        shouldHandoff: true,
        chunks: [],
      });

      await forwardMessageToN8n(session, message);
      expect((await getBotMessages(session.id)).length).toBe(1);
    });

    it('should handle concurrent messages to same session', async () => {
      const tenant = await createTestTenant({
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const session = await createTestSession(tenant.id, { status: 'bot' });
      const p = await createTestParticipant(session.id, { type: 'user' });
      const msg1 = await createTestMessage(session.id, tenant.id, p.id, { content: 'Msg 1' });
      const msg2 = await createTestMessage(session.id, tenant.id, p.id, { content: 'Msg 2' });

      mockGenerateResponse
        .mockResolvedValueOnce(ragSuccess('Reply 1'))
        .mockResolvedValueOnce(ragSuccess('Reply 2'));

      const [r1, r2] = await Promise.all([
        forwardMessageToN8n(session, msg1),
        forwardMessageToN8n(session, msg2),
      ]);

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(mockGenerateResponse).toHaveBeenCalledTimes(2);
    });

    it('should handle empty message content', async () => {
      const tenant = await createTestTenant({
        settings: { ai: aiSettings(), features: { fileUploadEnabled: true, handoffEnabled: true } },
      });
      const session = await createTestSession(tenant.id, { status: 'bot' });
      const p = await createTestParticipant(session.id, { type: 'user' });
      const message = await createTestMessage(session.id, tenant.id, p.id, { content: '' });

      mockGenerateResponse.mockResolvedValue(ragSuccess('Missed that.'));
      expect(await forwardMessageToN8n(session, message)).toBe(true);
    });

    it('should handle tenant with settings cleared mid-conversation', async () => {
      const tenant = await createTestTenant({
        settings: { ai: aiSettings() },
      });
      const { session, message } = await setup(tenant.id);
      await tenantRepo.update(tenant.id, { settings: {} });

      expect(await forwardMessageToN8n(session, message)).toBe(false);
    });
  });
});
