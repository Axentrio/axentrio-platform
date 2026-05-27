import { describe, it, expect } from 'vitest';
import { normalizeMetaPayload } from '../../channels/meta/event-normalizer';

describe('Meta Event Normalizer', () => {
  describe('Messenger text messages', () => {
    it('should normalize a text message', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'USER_456' },
            recipient: { id: 'PAGE_123' },
            timestamp: 1711756800000,
            message: { mid: 'm_abc123', text: 'Hello from Messenger!' },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].channel).toBe('messenger');
      expect(results[0].recipientId).toBe('PAGE_123');
      expect(results[0].event.type).toBe('message');
      expect(results[0].event.message?.type).toBe('text');
      expect(results[0].event.message?.content).toBe('Hello from Messenger!');
      expect(results[0].event.sender.externalUserId).toBe('USER_456');
    });

    it('should skip echo messages', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'PAGE_123' },
            recipient: { id: 'USER_456' },
            timestamp: 1711756800000,
            message: { mid: 'm_echo', text: 'Bot reply', is_echo: true },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(0);
    });
  });

  describe('Instagram messages', () => {
    it('should normalize an Instagram text message', () => {
      const payload = {
        object: 'instagram' as const,
        entry: [{
          id: 'IG_BIZ_789',
          time: 1711756800,
          messaging: [{
            sender: { id: 'IGSID_111' },
            recipient: { id: 'IG_BIZ_789' },
            timestamp: 1711756800000,
            message: { mid: 'm_ig_abc', text: 'Hello from Instagram!' },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].channel).toBe('instagram');
      expect(results[0].recipientId).toBe('IG_BIZ_789');
      expect(results[0].event.message?.content).toBe('Hello from Instagram!');
    });
  });

  describe('attachments', () => {
    it('should normalize an image attachment', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'USER_456' },
            recipient: { id: 'PAGE_123' },
            timestamp: 1711756800000,
            message: {
              mid: 'm_img',
              attachments: [{
                type: 'image' as const,
                payload: { url: 'https://example.com/photo.jpg' },
              }],
            },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].event.message?.type).toBe('image');
      expect(results[0].event.message?.mediaUrl).toBe('https://example.com/photo.jpg');
    });
  });

  describe('postbacks and quick replies', () => {
    it('should normalize a postback', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'USER_456' },
            recipient: { id: 'PAGE_123' },
            timestamp: 1711756800000,
            postback: { title: 'Get Started', payload: 'GET_STARTED' },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].event.type).toBe('postback');
      expect(results[0].event.postback?.payload).toBe('GET_STARTED');
    });

    it('should normalize a quick reply as postback', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'USER_456' },
            recipient: { id: 'PAGE_123' },
            timestamp: 1711756800000,
            message: {
              mid: 'm_qr',
              text: 'Option A',
              quick_reply: { payload: 'OPTION_A' },
            },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].event.type).toBe('postback');
      expect(results[0].event.postback?.payload).toBe('OPTION_A');
    });
  });

  describe('delivery and read receipts', () => {
    it('should normalize delivery receipt', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'USER_456' },
            recipient: { id: 'PAGE_123' },
            timestamp: 1711756800000,
            delivery: { mids: ['m_1', 'm_2'], watermark: 1711756800000 },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].event.type).toBe('delivery');
      expect(results[0].event.receipt?.messageIds).toEqual(['m_1', 'm_2']);
    });

    it('should normalize read receipt as log-only', () => {
      const payload = {
        object: 'page' as const,
        entry: [{
          id: 'PAGE_123',
          time: 1711756800,
          messaging: [{
            sender: { id: 'USER_456' },
            recipient: { id: 'PAGE_123' },
            timestamp: 1711756800000,
            read: { watermark: 1711756800000 },
          }],
        }],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(1);
      expect(results[0].event.type).toBe('read');
      expect(results[0].event.receipt?.messageIds).toEqual([]);
    });
  });

  describe('multiple events in single webhook', () => {
    it('should normalize multiple events from different pages', () => {
      const payload = {
        object: 'page' as const,
        entry: [
          {
            id: 'PAGE_A',
            time: 1711756800,
            messaging: [{
              sender: { id: 'USER_1' },
              recipient: { id: 'PAGE_A' },
              timestamp: 1711756800000,
              message: { mid: 'm_1', text: 'Message to Page A' },
            }],
          },
          {
            id: 'PAGE_B',
            time: 1711756800,
            messaging: [{
              sender: { id: 'USER_2' },
              recipient: { id: 'PAGE_B' },
              timestamp: 1711756800000,
              message: { mid: 'm_2', text: 'Message to Page B' },
            }],
          },
        ],
      };

      const results = normalizeMetaPayload(payload);
      expect(results).toHaveLength(2);
      expect(results[0].recipientId).toBe('PAGE_A');
      expect(results[1].recipientId).toBe('PAGE_B');
    });
  });
});
