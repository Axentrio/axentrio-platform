import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks } from '../helpers/auth';

createAuthMocks();

vi.mock('@clerk/express', () => ({ clerkMiddleware: () => (_req: any, _res: any, next: any) => next() }));

const { send, routeOutboundMessage, emitToTenantAgents, emitToSession, emitToAgent } = vi.hoisted(() => ({
  send: vi.fn(),
  routeOutboundMessage: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToSession: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../automations', () => ({ getEmailService: () => ({ send }) }));
vi.mock('../../queue/message-queue', () => ({
  addNotificationJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToTenantAgents: (...args: unknown[]) => emitToTenantAgents(...args),
  emitToSession: (...args: unknown[]) => emitToSession(...args),
  emitToAgent: (...args: unknown[]) => emitToAgent(...args),
}));
vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: (...args: unknown[]) => routeOutboundMessage(...args),
  sendChannelTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../llm/localize', () => ({
  localizeMessage: (message: string) => Promise.resolve(message),
}));

import { AppDataSource } from '../../database/data-source';
import request from 'supertest';
import { app } from '../../server';
import type { Bot } from '../../database/entities/Bot';
import { EmailDelivery } from '../../database/entities/EmailDelivery';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
import { Notification } from '../../database/entities/Notification';
import { createTestAnchorBot, createTestSession, createTestTenant, createTestUser, createTestParticipant, createTestMessage } from '../helpers/factories';
import { conversationCommands } from '../../services/conversation-command.service';
import { forwardMessageToN8n, initializeAgentService } from '../../services/message-forwarding.service';
import type { AgentService } from '../../agent/agent.service';
import { emailDeliveryService } from '../../services/email-delivery.service';
import { notificationService } from '../../services/notification.service';

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ success: true, messageId: 'handoff-email-1' });
  routeOutboundMessage.mockReset().mockResolvedValue({ success: true });
  emitToTenantAgents.mockReset();
  emitToSession.mockReset();
  emitToAgent.mockReset();
  initializeAgentService({ run: vi.fn() } as unknown as AgentService);
});

async function makeBotHandoffFixture() {
  const tenant = await createTestTenant({ name: 'Acme Support' });
  await createTestAnchorBot(tenant, {
    name: 'Acme Assistant',
    settings: {
      features: { fileUploadEnabled: true, handoffEnabled: true },
      ai: {
        enabled: true,
        brandVoice: { name: 'Acme Assistant', tone: 'friendly' },
        guardrails: {
          topicsToAvoid: [],
          escalationKeywords: ['speak to human'],
          confidenceThreshold: 0.5,
          maxResponseLength: 500,
          greetingMessage: 'Hello!',
          fallbackMessage: "I'm connecting you to a human agent.",
          offHoursMessage: "We're closed.",
        },
      },
    },
  });

  const session = await createTestSession(tenant.id, { status: 'bot' });
  const participant = await createTestParticipant(session.id, { type: 'user', name: 'Ada Customer' });
  const message = await createTestMessage(session.id, tenant.id, participant.id, {
    content: 'I want to speak to human',
  });
  return { tenant, session, message };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for handoff notification fan-out');
}

describe('bot-triggered handoff notifications', () => {
  it('fans out per-recipient platform/email deliveries using defaults and stored opt-outs', async () => {
    const { tenant, session, message } = await makeBotHandoffFixture();
    const defaultUser = await createTestUser(tenant.id, {
      email: 'default@example.com',
      notificationPreferences: null,
    });
    const platformOnlyUser = await createTestUser(tenant.id, {
      email: 'platform-only@example.com',
      notificationPreferences: { email: false, handoffRequest: true },
    });
    const optedOutUser = await createTestUser(tenant.id, {
      email: 'opted-out@example.com',
      notificationPreferences: { handoffRequest: false },
    });

    await expect(forwardMessageToN8n(session, message)).resolves.toBe(true);

    const handoffRepo = AppDataSource.getRepository(HandoffRequest);
    const handoff = await handoffRepo.findOneByOrFail({ sessionId: session.id });
    const notificationRepo = AppDataSource.getRepository(Notification);
    const emailRepo = AppDataSource.getRepository(EmailDelivery);
    await waitFor(
      async () =>
        (await notificationRepo.count({ where: { type: 'handoff_requested' } })) === 2 &&
        // the email send runs after the notification fan-out, so wait for it too
        (await emailRepo.count({ where: { relatedId: handoff.id, status: 'sent' } })) === 1,
    );

    const notifications = await notificationRepo.find({ where: { type: 'handoff_requested' } });
    expect(notifications).toHaveLength(2);
    expect(notifications.map((n) => n.recipientUserId)).toEqual(
      expect.arrayContaining([defaultUser.id, platformOnlyUser.id]),
    );
    expect(notifications.some((n) => n.recipientUserId === optedOutUser.id)).toBe(false);

    // #129: the realtime toast follows the pref-filtered recipient list — each
    // opted-in operator gets one in their OWN room; the opted-out one gets none.
    const toastedUserIds = emitToAgent.mock.calls
      .filter((c) => c[1] === 'notification')
      .map((c) => c[0]);
    expect(toastedUserIds).toEqual(expect.arrayContaining([defaultUser.id, platformOnlyUser.id]));
    expect(toastedUserIds).not.toContain(optedOutUser.id);
    expect(notifications[0].data).toMatchObject({
      sessionId: session.id,
      handoffId: handoff.id,
      deepLink: expect.stringContaining(`/inbox?chat=${session.id}`),
    });

    const emailDeliveries = await emailRepo.find({ where: { relatedId: handoff.id } });
    expect(emailDeliveries).toHaveLength(1);
    expect(emailDeliveries[0]).toMatchObject({
      recipientUserId: defaultUser.id,
      recipientEmail: 'default@example.com',
      idempotencyKey: `handoff:${handoff.id}:${defaultUser.id}`,
      status: 'sent',
    });
    expect(await emailRepo.findOne({ where: { recipientUserId: optedOutUser.id } })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);

    const duplicate = await conversationCommands.requestHandoff(
      session.id,
      'user_request',
      'widget',
    );
    expect(duplicate.outcome).toBe('already_requested');

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await notificationRepo.count({ where: { type: 'handoff_requested' } })).toBe(2);
    expect(await emailRepo.count({ where: { relatedId: handoff.id } })).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not let a notification service throw fail the handoff request', async () => {
    const { tenant, session, message } = await makeBotHandoffFixture();
    await createTestUser(tenant.id, { email: 'operator@example.com' });
    const spy = vi.spyOn(notificationService, 'createForRecipients').mockRejectedValue(new Error('notification down'));

    try {
      await expect(forwardMessageToN8n(session, message)).resolves.toBe(true);
      await waitFor(async () => spy.mock.calls.length > 0);
      expect(await AppDataSource.getRepository(HandoffRequest).count({ where: { sessionId: session.id } })).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not let an email delivery service throw fail the handoff request', async () => {
    const { tenant, session, message } = await makeBotHandoffFixture();
    await createTestUser(tenant.id, { email: 'operator@example.com' });
    const spy = vi.spyOn(emailDeliveryService, 'sendDurable').mockRejectedValue(new Error('email ledger down'));

    try {
      await expect(forwardMessageToN8n(session, message)).resolves.toBe(true);
      await waitFor(async () => spy.mock.calls.length > 0);
      expect(await AppDataSource.getRepository(HandoffRequest).count({ where: { sessionId: session.id } })).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('widget-initiated handoff notifications', () => {
  it('creates a platform notification and durable email delivery for an eligible operator', async () => {
    const tenant = await createTestTenant({ name: 'Widget Support' });
    const bot = await createTestAnchorBot(tenant, {
      name: 'Widget Assistant',
      settings: {
        features: { fileUploadEnabled: true, handoffEnabled: true },
        ai: { enabled: true },
      } as unknown as Bot['settings'],
    });
    const operator = await createTestUser(tenant.id, {
      email: 'widget-operator@example.com',
      notificationPreferences: null,
    });

    const init = await request(app)
      .post('/api/v1/widget/init')
      .send({ apiKey: bot.publicKey, visitorId: `widget-notify-${tenant.id}` });
    expect(init.status).toBe(200);
    const token = init.body.data.token as string;
    const sessionId = init.body.data.session.id as string;

    const response = await request(app)
      .post('/api/v1/widget/handoff')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'user_request' });
    expect(response.status).toBe(200);

    const handoff = await AppDataSource.getRepository(HandoffRequest).findOneByOrFail({ sessionId });
    const notificationRepo = AppDataSource.getRepository(Notification);
    const emailRepo = AppDataSource.getRepository(EmailDelivery);
    await waitFor(async () => {
      const notifications = await notificationRepo.count({
        where: { tenantId: tenant.id, type: 'handoff_requested' },
      });
      const emails = await emailRepo.count({ where: { tenantId: tenant.id, relatedId: handoff.id } });
      return notifications === 1 && emails === 1;
    });

    const notifications = await notificationRepo.find({
      where: { tenantId: tenant.id, type: 'handoff_requested' },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].recipientUserId).toBe(operator.id);

    const emailDeliveries = await emailRepo.find({ where: { tenantId: tenant.id, relatedId: handoff.id } });
    expect(emailDeliveries).toHaveLength(1);
    expect(emailDeliveries[0]).toMatchObject({
      recipientUserId: operator.id,
      recipientEmail: operator.email,
      idempotencyKey: `handoff:${handoff.id}:${operator.id}`,
      status: 'sent',
    });
  });
});
