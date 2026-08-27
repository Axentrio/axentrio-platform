import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Tenant } from '../../database/entities/Tenant';
import {
  createTestTenant,
  createTestAnchorBot,
  createTestSession,
  createTestParticipant,
  createTestMessage,
} from '../helpers/factories';
import { BotSettings } from '../../database/entities/Bot';
import {
  getNewestUnansweredUserMessage,
  getCoalescedHistory,
} from '../../services/unanswered-window';
import { runTurn, initializeAgentService } from '../../services/message-forwarding.service';
import type { AgentService } from '../../agent/agent.service';
import { encrypt } from '../../utils/encryption';

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));
vi.mock('../../llm/localize', () => ({
  localizeMessage: vi.fn((message: string) => Promise.resolve(message)),
}));
vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
  routeTypingIndicator: vi.fn().mockResolvedValue(undefined),
  sendChannelTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));

const sessionRepo = AppDataSource.getRepository(ChatSession);

const AI = {
  enabled: true,
  provider: 'openai' as const,
  model: 'gpt-4o-mini',
  brandVoice: { name: 'TestBot', tone: 'friendly' as const, customInstructions: 'Be helpful.' },
  guardrails: {
    topicsToAvoid: [],
    escalationKeywords: [],
    confidenceThreshold: 0.5,
    maxResponseLength: 500,
    greetingMessage: 'Hi',
    fallbackMessage: 'Connecting you to a human.',
    offHoursMessage: 'Closed.',
  },
};

async function makeTenantWithAi(): Promise<Tenant> {
  const tenant = await createTestTenant({ settings: { ai: { apiKey: 'sk-test' } } as never });
  await createTestAnchorBot(tenant, { settings: { ai: AI } as BotSettings });
  return tenant;
}

afterEach(() => {
  initializeAgentService(null as unknown as AgentService);
  vi.unstubAllEnvs();
});

describe('file extraction visibility', () => {
  it('treats a ready file as the live turn and fences it in history', async () => {
    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    const file = await createTestMessage(session.id, tenant.id, user.id, {
      type: 'file',
      content: 'caption',
      metadata: {
        fileName: 'balans.pdf',
        extraction: {
          status: 'ready',
          text: encrypt('Omzet 117.620,00'),
          textEncrypted: true,
          pages: 5,
          method: 'text',
        },
      },
    });
    const later = await createTestMessage(session.id, tenant.id, user.id, { content: 'thanks' });

    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    const newest = await getNewestUnansweredUserMessage(fresh);
    expect(newest?.id).toBe(later.id);

    const history = await getCoalescedHistory(session.id, later.id);
    const fileTurn = history.find((t) => t.content.includes('ATTACHED_DOCUMENT'));
    expect(fileTurn?.content).toContain('balans.pdf');
    expect(fileTurn?.content).toContain('Omzet 117.620,00');
    expect(file.id).toBeTruthy();
  });

  it('hides pending files and files with no extraction key', async () => {
    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    await createTestMessage(session.id, tenant.id, user.id, {
      type: 'file',
      content: '',
      metadata: { fileName: 'pending.pdf', extraction: { status: 'pending', startedAt: new Date().toISOString() } },
    });
    const freshPending = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    expect(await getNewestUnansweredUserMessage(freshPending)).toBeNull();

    const session2 = await createTestSession(tenant.id, { status: 'bot' });
    const user2 = await createTestParticipant(session2.id, { type: 'user', name: 'Visitor' });
    await createTestMessage(session2.id, tenant.id, user2.id, {
      type: 'file',
      content: '',
      metadata: { fileName: 'bare.pdf' },
    });
    const freshBare = await sessionRepo.findOneOrFail({ where: { id: session2.id } });
    expect(await getNewestUnansweredUserMessage(freshBare)).toBeNull();
  });
});

describe('runTurn pending extraction hold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns pending-document while extraction is fresh', async () => {
    const runMock = vi.fn().mockResolvedValue({ type: 'response', content: 'ok' });
    initializeAgentService({ run: runMock } as unknown as AgentService);
    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    const text = await createTestMessage(session.id, tenant.id, user.id, { content: 'see the pdf' });
    await createTestMessage(session.id, tenant.id, user.id, {
      type: 'file',
      content: '',
      metadata: {
        fileName: 'a.pdf',
        extraction: { status: 'pending', startedAt: new Date().toISOString() },
      },
    });
    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    expect(await runTurn(fresh, text)).toBe('pending-document');
    expect(runMock).not.toHaveBeenCalled();
  });

  it('proceeds when pending extraction is older than 3 minutes', async () => {
    const runMock = vi.fn().mockResolvedValue({ type: 'response', content: 'ok' });
    initializeAgentService({ run: runMock } as unknown as AgentService);
    const tenant = await makeTenantWithAi();
    const session = await createTestSession(tenant.id, { status: 'bot' });
    const user = await createTestParticipant(session.id, { type: 'user', name: 'Visitor' });
    const text = await createTestMessage(session.id, tenant.id, user.id, { content: 'see the pdf' });
    const staleAt = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    await createTestMessage(session.id, tenant.id, user.id, {
      type: 'file',
      content: '',
      metadata: {
        fileName: 'a.pdf',
        extraction: { status: 'pending', startedAt: staleAt },
      },
    });
    const fresh = await sessionRepo.findOneOrFail({ where: { id: session.id } });
    expect(await runTurn(fresh, text)).toBe('answered');
    expect(runMock).toHaveBeenCalled();
  });
});
