import { describe, it, expect, vi } from 'vitest';

// Isolate the guardrails wiring from real channel/socket delivery.
vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
  sendChannelTypingIndicator: vi.fn(),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToTenantAgents: vi.fn(),
  emitToSession: vi.fn(),
}));

import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { GuardrailOutputLog } from '../../database/entities/GuardrailOutputLog';
import { WebhookService } from '../../n8n/webhook.service';
import type { EventEmitter } from '../../utils/event-emitter';
import { createTestTenant, createTestSession } from '../helpers/factories';

const FALLBACK = "We're connecting you to an agent. Please hold on.";
const BAD = 'Please share your bank login password so I can verify your account.';

function service() {
  return new WebhookService({ eventEmitter: { emit: vi.fn() } as unknown as EventEmitter });
}

async function setup(enforce: boolean) {
  const tenant = await createTestTenant({ settings: enforce ? { guardrails: { enforce: true } } : {} });
  const session = await createTestSession(tenant.id, { status: 'bot' });
  return { tenant, session: await AppDataSource.getRepository(ChatSession).findOneOrFail({ where: { id: session.id } }) };
}

const lastBotText = async (sessionId: string) => {
  const msgs = await AppDataSource.getRepository(Message).find({ where: { sessionId } });
  return msgs.map((m) => m.content);
};

describe('guardrails · n8n output gate (integration)', () => {
  it('ENFORCE: replaces a flagged n8n reply with the fallback and hands off', async () => {
    const { session } = await setup(true);
    const res = await service().sendMessageToSession(session.id, { type: 'text', content: BAD });
    expect(res.success).toBe(true);

    const contents = await lastBotText(session.id);
    expect(contents).toContain(FALLBACK);
    expect(contents).not.toContain(BAD);

    const reloaded = await AppDataSource.getRepository(ChatSession).findOneOrFail({ where: { id: session.id } });
    expect(reloaded.status).toBe('handoff');

    const logs = await AppDataSource.getRepository(GuardrailOutputLog).find({ where: { conversationId: session.id } });
    expect(logs.length).toBe(1);
    expect(logs[0].enforced).toBe(true);
    expect(logs[0].generationPath).toBe('n8n');
  });

  it('ENFORCE: flags a bad quick-reply LABEL (not just content) and coerces to fallback + handoff', async () => {
    const { session } = await setup(true);
    const res = await service().sendMessageToSession(session.id, {
      type: 'quick_reply',
      content: 'How can I help?', // clean content…
      quickReplies: [{ title: 'Share your password to continue', value: 'pw' }], // …bad LABEL
    });
    expect(res.success).toBe(true);

    const contents = await lastBotText(session.id);
    expect(contents).toContain(FALLBACK);
    const reloaded = await AppDataSource.getRepository(ChatSession).findOneOrFail({ where: { id: session.id } });
    expect(reloaded.status).toBe('handoff');
  });

  it('rejects an n8n edit on a guardrail-paused session', async () => {
    const { session } = await setup(false);
    await AppDataSource.getRepository(ChatSession).update(session.id, { aiAutoReplyEnabled: false });
    const res = await service().editMessage(session.id, {
      content: 'edited text',
      metadata: { messageId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/guardrail-paused/);
  });

  it('requestFileUpload: rejected on a guardrail-paused session', async () => {
    const { session } = await setup(false);
    await AppDataSource.getRepository(ChatSession).update(session.id, { aiAutoReplyEnabled: false });
    const res = await service().requestFileUpload(session.id, { types: ['image'], prompt: 'Upload your ID' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/guardrail-paused/);
  });

  it('ENFORCE: a blocked file-request prompt hands off and shows no upload UI', async () => {
    const { session } = await setup(true);
    const emit = vi.fn();
    const svc = new WebhookService({ eventEmitter: { emit } as unknown as EventEmitter });
    const res = await svc.requestFileUpload(session.id, {
      types: ['image'],
      prompt: 'Enter your CVV and card number to verify',
    });
    expect(res.success).toBe(true);
    expect(emit.mock.calls.some((c) => c[0] === 'file:requested')).toBe(false);
    const reloaded = await AppDataSource.getRepository(ChatSession).findOneOrFail({ where: { id: session.id } });
    expect(reloaded.status).toBe('handoff');
  });

  it('ENFORCE: a blocked quick_reply is coerced to plain text — no actions ride along', async () => {
    const { session } = await setup(true);
    const res = await service().sendMessageToSession(session.id, {
      type: 'quick_reply',
      content: BAD,
      quickReplies: ['Share password', 'Cancel'],
    });
    expect(res.success).toBe(true);

    const msgs = await AppDataSource.getRepository(Message).find({ where: { sessionId: session.id } });
    const bot = msgs.find((m) => m.content === FALLBACK);
    expect(bot).toBeTruthy();
    // The original quick replies must NOT survive the block.
    expect(bot?.metadata?.quickReplies).toBeUndefined();
  });

  it('SHADOW: sends the original n8n reply, logs, no handoff', async () => {
    const { session } = await setup(false);
    const res = await service().sendMessageToSession(session.id, { type: 'text', content: BAD });
    expect(res.success).toBe(true);

    const contents = await lastBotText(session.id);
    expect(contents).toContain(BAD);

    const reloaded = await AppDataSource.getRepository(ChatSession).findOneOrFail({ where: { id: session.id } });
    expect(reloaded.status).toBe('bot');

    const logs = await AppDataSource.getRepository(GuardrailOutputLog).find({ where: { conversationId: session.id } });
    expect(logs.length).toBe(1);
    expect(logs[0].enforced).toBe(false);
  });
});
