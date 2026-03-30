import { describe, it, expect } from 'vitest';
import { TelegramEventNormalizer } from '../../channels/telegram/event-normalizer';
import { ChannelConnection } from '../../database/entities/ChannelConnection';

const normalizer = new TelegramEventNormalizer();

function mockConnection(): ChannelConnection {
  const conn = new ChannelConnection();
  conn.id = 'conn-123';
  conn.tenantId = 'tenant-123';
  conn.channel = 'telegram';
  conn.status = 'active';
  conn.credentials = { botToken: 'test-bot-token' };
  return conn;
}

describe('TelegramEventNormalizer', () => {
  const connection = mockConnection();

  describe('text messages', () => {
    it('should normalize a simple text message', () => {
      const update = {
        update_id: 100001,
        message: {
          message_id: 1,
          from: { id: 999, is_bot: false, first_name: 'John', last_name: 'Doe', username: 'johndoe' },
          chat: { id: 999, type: 'private' as const, first_name: 'John' },
          date: 1711756800,
          text: 'Hello from Telegram!',
        },
      };

      const events = normalizer.normalize(update, connection);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.type).toBe('message');
      expect(event.message?.type).toBe('text');
      expect(event.message?.content).toBe('Hello from Telegram!');
      expect(event.dedupeKey).toBe('telegram:100001');
      expect(event.sender.externalUserId).toBe('999');
      expect(event.sender.externalThreadId).toBe('999');
      expect(event.sender.displayName).toBe('John Doe');
    });

    it('should skip bot messages', () => {
      const update = {
        update_id: 100002,
        message: {
          message_id: 2,
          from: { id: 123, is_bot: true, first_name: 'MyBot' },
          chat: { id: 999, type: 'private' as const },
          date: 1711756800,
          text: 'Bot reply',
        },
      };

      const events = normalizer.normalize(update, connection);
      expect(events).toHaveLength(0);
    });
  });

  describe('media messages', () => {
    it('should normalize a photo message', () => {
      const update = {
        update_id: 100003,
        message: {
          message_id: 3,
          from: { id: 999, is_bot: false, first_name: 'John' },
          chat: { id: 999, type: 'private' as const },
          date: 1711756800,
          photo: [
            { file_id: 'small_id', file_unique_id: 'u1', width: 100, height: 100 },
            { file_id: 'large_id', file_unique_id: 'u2', width: 800, height: 600, file_size: 50000 },
          ],
          caption: 'Check this out',
        },
      };

      const events = normalizer.normalize(update, connection);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.message?.type).toBe('image');
      expect(event.message?.content).toBe('Check this out');
      expect(event.message?.mediaMetadata?.fileId).toBe('large_id'); // Uses largest
    });

    it('should normalize a document message', () => {
      const update = {
        update_id: 100004,
        message: {
          message_id: 4,
          from: { id: 999, is_bot: false, first_name: 'John' },
          chat: { id: 999, type: 'private' as const },
          date: 1711756800,
          document: {
            file_id: 'doc_id',
            file_unique_id: 'u3',
            file_name: 'report.pdf',
            file_size: 100000,
            mime_type: 'application/pdf',
          },
        },
      };

      const events = normalizer.normalize(update, connection);
      expect(events).toHaveLength(1);
      expect(events[0].message?.type).toBe('file');
      expect(events[0].message?.mediaMetadata?.fileName).toBe('report.pdf');
    });

    it('should normalize a location message', () => {
      const update = {
        update_id: 100005,
        message: {
          message_id: 5,
          from: { id: 999, is_bot: false, first_name: 'John' },
          chat: { id: 999, type: 'private' as const },
          date: 1711756800,
          location: { latitude: 40.7128, longitude: -74.006 },
        },
      };

      const events = normalizer.normalize(update, connection);
      expect(events).toHaveLength(1);
      expect(events[0].message?.type).toBe('location');
      expect(events[0].message?.content).toBe('40.7128,-74.006');
    });
  });

  describe('callback queries', () => {
    it('should normalize a callback query as postback', () => {
      const update = {
        update_id: 100006,
        callback_query: {
          id: 'cb-456',
          from: { id: 999, is_bot: false, first_name: 'John' },
          message: {
            message_id: 10,
            chat: { id: 999, type: 'private' as const },
            date: 1711756800,
          },
          data: 'button_payload_value',
        },
      };

      const events = normalizer.normalize(update, connection);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.type).toBe('postback');
      expect(event.postback?.payload).toBe('button_payload_value');
      expect(event.dedupeKey).toBe('telegram:cb:cb-456');
    });
  });

  describe('empty updates', () => {
    it('should return empty array for unsupported update types', () => {
      const update = {
        update_id: 100007,
        // No message or callback_query
      };

      const events = normalizer.normalize(update, connection);
      expect(events).toHaveLength(0);
    });
  });

  describe('group messages', () => {
    it('should use chat.id as externalThreadId for groups', () => {
      const update = {
        update_id: 100008,
        message: {
          message_id: 8,
          from: { id: 999, is_bot: false, first_name: 'John' },
          chat: { id: -1001234567890, type: 'supergroup' as const, title: 'My Group' },
          date: 1711756800,
          text: 'Group message',
        },
      };

      const events = normalizer.normalize(update, connection);
      expect(events).toHaveLength(1);
      expect(events[0].sender.externalUserId).toBe('999');
      expect(events[0].sender.externalThreadId).toBe('-1001234567890');
    });
  });
});
