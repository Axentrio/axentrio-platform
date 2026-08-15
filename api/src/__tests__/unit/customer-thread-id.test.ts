/**
 * customerThreadId projection (B-PR4a §5) - the COMPUTED durable thread key.
 * Pure function tests: no DB. The keys documented in the plan:
 *
 *   widget    w:{tenantId}:{botId}:{visitorId}
 *   external  e:{channelConnectionId}:{externalUserId}:{externalThreadId}
 *   fallback  s:{sessionId}            (external session with no binding row)
 */
import { describe, it, expect } from 'vitest';
import {
  computeCustomerThreadId,
  serializeConversationSummary,
} from '../../realtime/conversation-serializer';
import type { ChatSession } from '../../database/entities/ChatSession';

const base = {
  id: 'sess-1',
  tenantId: 'tenant-1',
  botId: 'bot-1',
  visitorId: 'widget-abc123',
  source: 'widget',
};

function fakeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    ...base,
    status: 'bot',
    ownership: 'bot_owned',
    ownershipVersion: 0,
    aiAutoReplyEnabled: true,
    guardrailStatus: 'normal',
    channel: 'widget',
    messageCount: 0,
    lastActivityAt: new Date('2026-08-14T00:00:00Z'),
    createdAt: new Date('2026-08-14T00:00:00Z'),
    ...overrides,
  } as unknown as ChatSession;
}

describe('computeCustomerThreadId', () => {
  it('widget sessions key on tenant + bot + stable visitor', () => {
    expect(computeCustomerThreadId(base)).toBe('w:tenant-1:bot-1:widget-abc123');
  });

  it('widget sessions ignore a binding even if one is passed (defensive)', () => {
    expect(
      computeCustomerThreadId(base, {
        channelConnectionId: 'conn-1',
        externalUserId: 'u1',
        externalThreadId: 't1',
      }),
    ).toBe('w:tenant-1:bot-1:widget-abc123');
  });

  it('external sessions key on connection + external user + external thread', () => {
    const session = { ...base, source: 'telegram' };
    expect(
      computeCustomerThreadId(session, {
        channelConnectionId: 'conn-1',
        externalUserId: 'tg-user-9',
        externalThreadId: 'tg-chat-9',
      }),
    ).toBe('e:conn-1:tg-user-9:tg-chat-9');
  });

  it('a Telegram DM and a group chat are DIFFERENT threads (same user, different chat)', () => {
    const session = { ...base, source: 'telegram' };
    const dm = computeCustomerThreadId(session, {
      channelConnectionId: 'conn-1',
      externalUserId: 'tg-user-9',
      externalThreadId: 'tg-user-9', // Telegram DM: chat id == user id
    });
    const group = computeCustomerThreadId(session, {
      channelConnectionId: 'conn-1',
      externalUserId: 'tg-user-9',
      externalThreadId: 'tg-group-777',
    });
    expect(dm).toBe('e:conn-1:tg-user-9:tg-user-9');
    expect(group).toBe('e:conn-1:tg-user-9:tg-group-777');
    expect(dm).not.toBe(group);
  });

  it('an external session with no binding falls back to s:{sessionId}', () => {
    const session = { ...base, source: 'messenger' };
    expect(computeCustomerThreadId(session, null)).toBe('s:sess-1');
    expect(computeCustomerThreadId(session)).toBe('s:sess-1');
  });
});

describe('serializeConversationSummary carries customerThreadId', () => {
  it('widget row: computed from the session alone', () => {
    const dto = serializeConversationSummary(fakeSession(), { lastMessage: null });
    expect(dto.customerThreadId).toBe('w:tenant-1:bot-1:widget-abc123');
  });

  it('external row: computed from the passed binding', () => {
    const dto = serializeConversationSummary(
      fakeSession({ source: 'telegram', channel: 'telegram' } as Partial<ChatSession>),
      {
        lastMessage: null,
        binding: {
          channelConnectionId: 'conn-2',
          externalUserId: 'ext-u',
          externalThreadId: 'ext-t',
        },
      },
    );
    expect(dto.customerThreadId).toBe('e:conn-2:ext-u:ext-t');
  });

  it('external row without a binding: honest s:{sessionId} fallback', () => {
    const dto = serializeConversationSummary(
      fakeSession({ source: 'whatsapp', channel: 'whatsapp' } as Partial<ChatSession>),
      { lastMessage: null },
    );
    expect(dto.customerThreadId).toBe('s:sess-1');
  });
});
