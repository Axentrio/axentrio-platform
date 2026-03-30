import { describe, it, expect } from 'vitest';
import { formatResponseForChannel, ChannelCapabilities } from '../../channels/types';

const telegramCapabilities: ChannelCapabilities = {
  maxTextLength: 4096,
  supportsQuickReplies: true,
  maxQuickReplies: 100,
  supportsButtons: true,
  maxButtons: 100,
  supportsCarousel: false,
  maxCarouselCards: 0,
  supportsImages: true,
  supportsVideo: true,
  supportsAudio: true,
  supportsFiles: true,
  supportsTypingIndicator: true,
  supportsReadReceipts: false,
  supportsMessageEdit: true,
  supportsMessageDelete: true,
  supportsStickers: true,
  hasMessagingWindow: false,
  requiresTemplatesOutsideWindow: false,
};

const limitedCapabilities: ChannelCapabilities = {
  maxTextLength: 160,
  supportsQuickReplies: false,
  maxQuickReplies: 0,
  supportsButtons: false,
  maxButtons: 0,
  supportsCarousel: false,
  maxCarouselCards: 0,
  supportsImages: false,
  supportsVideo: false,
  supportsAudio: false,
  supportsFiles: false,
  supportsTypingIndicator: false,
  supportsReadReceipts: false,
  supportsMessageEdit: false,
  supportsMessageDelete: false,
  supportsStickers: false,
  hasMessagingWindow: false,
  requiresTemplatesOutsideWindow: false,
};

describe('formatResponseForChannel', () => {
  describe('text messages', () => {
    it('should pass through simple text', () => {
      const result = formatResponseForChannel(
        { type: 'text', content: 'Hello world' },
        telegramCapabilities,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');
      expect(result[0].content).toBe('Hello world');
    });

    it('should truncate text exceeding channel limit', () => {
      const longText = 'A'.repeat(200);
      const result = formatResponseForChannel(
        { type: 'text', content: longText },
        limitedCapabilities,
      );
      expect(result[0].content!.length).toBeLessThanOrEqual(160);
      expect(result[0].content!.endsWith('...')).toBe(true);
    });

    it('should handle missing type as text', () => {
      const result = formatResponseForChannel(
        { content: 'No type specified' },
        telegramCapabilities,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');
      expect(result[0].content).toBe('No type specified');
    });
  });

  describe('quick replies', () => {
    it('should include quick replies when supported', () => {
      const result = formatResponseForChannel(
        {
          type: 'quick_reply',
          content: 'Choose one',
          quickReplies: ['Option A', 'Option B'],
        },
        telegramCapabilities,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('quick_reply');
      expect(result[0].quickReplies).toHaveLength(2);
      expect(result[0].quickReplies![0]).toEqual({ title: 'Option A', payload: 'Option A' });
    });

    it('should strip quick replies when not supported', () => {
      const result = formatResponseForChannel(
        {
          type: 'quick_reply',
          content: 'Choose one',
          quickReplies: ['Option A', 'Option B'],
        },
        limitedCapabilities,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');
      expect(result[0].quickReplies).toBeUndefined();
    });
  });

  describe('media messages', () => {
    it('should pass through image when supported', () => {
      const result = formatResponseForChannel(
        { type: 'image', content: 'https://example.com/photo.jpg' },
        telegramCapabilities,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('image');
    });

    it('should fall back to text for unsupported media', () => {
      const result = formatResponseForChannel(
        { type: 'image', content: 'https://example.com/photo.jpg' },
        limitedCapabilities,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');
    });
  });

  describe('carousel', () => {
    it('should fall back to multiple text messages when carousel not supported', () => {
      const result = formatResponseForChannel(
        {
          type: 'carousel',
          attachments: [
            { url: 'https://img1.jpg', title: 'Card 1', description: 'Desc 1' } as any,
            { url: 'https://img2.jpg', title: 'Card 2', description: 'Desc 2' } as any,
          ],
        },
        telegramCapabilities, // Telegram doesn't support carousels
      );
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0].type).toBe('text');
      expect(result[0].content).toContain('Card 1');
    });
  });

  describe('typing indicator', () => {
    it('should produce typing message when supported', () => {
      const result = formatResponseForChannel(
        { type: 'typing' },
        telegramCapabilities,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('typing');
    });

    it('should produce empty array when typing not supported', () => {
      const result = formatResponseForChannel(
        { type: 'typing' },
        limitedCapabilities,
      );
      expect(result).toHaveLength(0);
    });
  });
});
