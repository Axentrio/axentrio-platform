/**
 * Regression: inbound channel messages must create a ChatSession bound to the
 * tenant's anchor bot. `chat_sessions.bot_id` is NOT NULL (multi-bot), and the
 * channel inbound path previously created sessions without it — which only
 * surfaced the first time a real Messenger DM hit prod. This locks it down.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { Bot } from '../../database/entities/Bot';
import { findOrCreateConversation } from '../../channels/inbound-pipeline';
import { upsertLead } from '../../leads/lead-capture.service';
import { createTestTenant, createTestAnchorBot } from '../helpers/factories';
import type { NormalizedEvent } from '../../channels/types';
import crypto from 'crypto';

// Keep these tests about the inbound→lead wiring; stub the fire-and-forget fan-out.
import { vi } from 'vitest';
vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: vi.fn(),
  buildEventBase: () => ({ id: 'e', tenantId: 't', sessionId: 's', timestamp: 'now', session: {} }),
}));
vi.mock('../../services/notification.service', () => ({
  notificationService: { createForTenant: vi.fn().mockResolvedValue(undefined) },
}));

async function createSecondaryBot(
  tenantId: string,
  status: 'active' | 'paused' = 'active',
): Promise<Bot> {
  const repo = AppDataSource.getRepository(Bot);
  return repo.save(
    repo.create({
      tenantId,
      name: 'Channel Bot',
      publicKey: `bk_${crypto.randomBytes(12).toString('hex')}`,
      status,
      isDefault: false,
      settings: {} as Bot['settings'],
    }),
  );
}

function messengerTextEvent(userId: string): NormalizedEvent {
  return {
    type: 'message',
    message: { type: 'text', content: 'hi' },
    sender: { externalUserId: userId, externalThreadId: userId, displayName: 'Test User' },
    dedupeKey: `test:meta:${userId}:${Date.now()}`,
    timestamp: new Date(),
    rawEventType: 'message.text',
  };
}

async function createMessengerConnection(tenantId: string): Promise<ChannelConnection> {
  const repo = AppDataSource.getRepository(ChannelConnection);
  return repo.save(
    repo.create({
      tenantId,
      channel: 'messenger',
      status: 'active',
      platformAccountId: `page_${Date.now()}`,
    }),
  );
}

describe('inbound-pipeline · findOrCreateConversation (channel session bot_id)', () => {
  it('creates a session bound to the tenant anchor bot', async () => {
    const tenant = await createTestTenant();
    const anchorBot = await createTestAnchorBot(tenant);
    const connection = await createMessengerConnection(tenant.id);

    const { session } = await findOrCreateConversation(messengerTextEvent('psid_111'), connection);

    // The bug: botId was null → NOT NULL violation. Now it must be the anchor bot.
    expect(session.botId).toBe(anchorBot.id);
    expect(session.tenantId).toBe(tenant.id);
    expect(session.channel).toBe('messenger');
    expect(session.status).toBe('waiting');
  });

  it('throws clearly if the tenant has no anchor bot', async () => {
    const tenant = await createTestTenant();
    const connection = await createMessengerConnection(tenant.id);

    await expect(
      findOrCreateConversation(messengerTextEvent('psid_222'), connection),
    ).rejects.toThrow(/anchor bot/i);
  });

  it('routes to the connection-assigned bot when set and active', async () => {
    const tenant = await createTestTenant();
    await createTestAnchorBot(tenant);
    const channelBot = await createSecondaryBot(tenant.id, 'active');
    const connection = await createMessengerConnection(tenant.id);
    connection.botId = channelBot.id;
    await AppDataSource.getRepository(ChannelConnection).save(connection);

    const { session } = await findOrCreateConversation(messengerTextEvent('psid_333'), connection);

    expect(session.botId).toBe(channelBot.id);
  });

  it('falls back to the anchor bot when the assigned bot is paused', async () => {
    const tenant = await createTestTenant();
    const anchorBot = await createTestAnchorBot(tenant);
    const pausedBot = await createSecondaryBot(tenant.id, 'paused');
    const connection = await createMessengerConnection(tenant.id);
    connection.botId = pausedBot.id;
    await AppDataSource.getRepository(ChannelConnection).save(connection);

    const { session } = await findOrCreateConversation(messengerTextEvent('psid_444'), connection);

    expect(session.botId).toBe(anchorBot.id);
  });
});

/**
 * Hook 1 (leads-across-all-channels) smoke: a brand-new channel binding must
 * surface as `created: true`, and feeding that binding into the lead-capture
 * service exactly as processInboundEvent does must land a real Lead row — with
 * no email and no LLM. A returning contact must report `created: false` so the
 * pipeline doesn't re-capture. This is the inbound→lead wiring end-to-end.
 */
describe('inbound-pipeline · Hook 1 channel lead capture', () => {
  it('first inbound → created:true → lands a no-email Lead; reuse → created:false', async () => {
    const tenant = await createTestTenant({ tier: 'pro' }); // pro ⇒ leadCapture on
    await createTestAnchorBot(tenant);
    const connection = await createMessengerConnection(tenant.id);

    // First contact.
    const first = await findOrCreateConversation(messengerTextEvent('psid_lead_1'), connection);
    expect(first.created).toBe(true);

    // Wire the upsert exactly like processInboundEvent's Hook 1.
    const res = await upsertLead({
      dataSource: AppDataSource,
      tenantId: connection.tenantId,
      sessionId: first.session.id,
      botId: first.session.botId ?? null,
      source: 'channel',
      channel: connection.channel,
      externalUserId: first.binding.externalUserId,
      name: first.binding.externalUserName,
    });
    expect(res?.inserted).toBe(true);

    const [lead] = await AppDataSource.query(
      `SELECT name, email, phone, channel, external_user_id, dedupe_key, source, status
         FROM chatbot_leads WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [tenant.id],
    );
    expect(lead.email).toBeNull();                       // channel lead — no email, by design
    expect(lead.channel).toBe('messenger');
    expect(lead.external_user_id).toBe('psid_lead_1');
    expect(lead.dedupe_key).toBe('messenger:psid_lead_1');
    expect(lead.name).toBe('Test User');
    expect(lead.source).toBe('channel');
    expect(lead.status).toBe('new');

    // Same contact messages again → returning binding → not a new lead.
    const second = await findOrCreateConversation(messengerTextEvent('psid_lead_1'), connection);
    expect(second.created).toBe(false);

    const rows = await AppDataSource.query(
      `SELECT count(*)::int n FROM chatbot_leads WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [tenant.id],
    );
    expect(rows[0].n).toBe(1); // still exactly one lead
  });
});
