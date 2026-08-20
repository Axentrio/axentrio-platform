import { describe, it, expect } from 'vitest';
import {
  displayNameFromSession,
  serializeConversationSummary,
} from '../../realtime/conversation-serializer';
import type { ChatSession } from '../../database/entities/ChatSession';

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'sess-1',
    tenantId: 'tenant-1',
    botId: 'bot-1',
    visitorId: 'abcdefghijklmnop',
    source: 'widget',
    channel: 'widget',
    status: 'bot',
    ownership: 'bot_owned',
    ownershipVersion: 0,
    aiAutoReplyEnabled: true,
    guardrailStatus: 'normal',
    messageCount: 0,
    lastActivityAt: new Date('2026-08-14T00:00:00Z'),
    createdAt: new Date('2026-08-14T00:00:00Z'),
    metadata: {},
    ...overrides,
  } as unknown as ChatSession;
}

describe('displayNameFromSession', () => {
  it('prefers metadata.customData.displayName over widget name and Visitor fallback', () => {
    expect(
      displayNameFromSession(
        session({
          metadata: { name: 'Widget Name', customData: { displayName: '  Ada  ' } },
        } as Partial<ChatSession>),
      ),
    ).toBe('Ada');
  });

  it('uses widget metadata.name when customData.displayName is missing', () => {
    expect(
      displayNameFromSession(session({ metadata: { name: '  Ian  ' } } as Partial<ChatSession>)),
    ).toBe('Ian');
  });

  it('falls back to Visitor <8-char visitor slice>', () => {
    expect(displayNameFromSession(session())).toBe('Visitor abcdefgh');
  });

  it('treats Meta fallback labels as missing', () => {
    expect(
      displayNameFromSession(
        session({
          metadata: { customData: { displayName: 'Facebook User' } },
        } as Partial<ChatSession>),
      ),
    ).toBe('Visitor abcdefgh');
  });
});

describe('serializeConversationSummary uses displayNameFromSession', () => {
  it('emits the metadata display name as userName', () => {
    const dto = serializeConversationSummary(
      session({
        metadata: { customData: { displayName: 'Ada Lovelace' } },
      } as Partial<ChatSession>),
      { lastMessage: null },
    );
    expect(dto.userName).toBe('Ada Lovelace');
  });
});
