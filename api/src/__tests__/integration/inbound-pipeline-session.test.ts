/**
 * Regression: inbound channel messages must create a ChatSession bound to the
 * tenant's anchor bot. `chat_sessions.bot_id` is NOT NULL (multi-bot), and the
 * channel inbound path previously created sessions without it — which only
 * surfaced the first time a real Messenger DM hit prod. This locks it down.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { findOrCreateConversation } from '../../channels/inbound-pipeline';
import { createTestTenant, createTestAnchorBot } from '../helpers/factories';
import type { NormalizedEvent } from '../../channels/types';

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
});
