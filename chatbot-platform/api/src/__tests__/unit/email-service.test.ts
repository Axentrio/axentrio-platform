import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

const mockEmailsSend = vi.fn();

vi.mock('resend', () => {
  class Resend {
    emails = { send: mockEmailsSend };
    constructor(_apiKey: string) {}
  }
  return { Resend };
});

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { EmailService } from '../../automations/email.service';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('EmailService', () => {
  const API_KEY = 're_test_abc123';
  const DEFAULT_FROM = 'noreply@notifications.example.com';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('send', () => {
    it('sends email via Resend and returns success with messageId', async () => {
      mockEmailsSend.mockResolvedValue({ data: { id: 'msg-001' }, error: null });

      const service = new EmailService(API_KEY, DEFAULT_FROM);
      const result = await service.send({
        to: 'alice@example.com',
        subject: 'Hello',
        body: '<p>Hello Alice</p>',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-001');
      expect(result.error).toBeUndefined();
      expect(mockEmailsSend).toHaveBeenCalledOnce();
      expect(mockEmailsSend).toHaveBeenCalledWith(
        expect.objectContaining({
          from: DEFAULT_FROM,
          to: ['alice@example.com'],
          subject: 'Hello',
          html: '<p>Hello Alice</p>',
        })
      );
    });

    it('handles Resend errors and returns failure result', async () => {
      mockEmailsSend.mockResolvedValue({ data: null, error: { message: 'Invalid API key' } });

      const service = new EmailService(API_KEY, DEFAULT_FROM);
      const result = await service.send({
        to: 'bob@example.com',
        subject: 'Test',
        body: '<p>Test</p>',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid API key');
      expect(result.messageId).toBeUndefined();
    });

    it('sends to multiple recipients', async () => {
      mockEmailsSend.mockResolvedValue({ data: { id: 'msg-multi' }, error: null });

      const service = new EmailService(API_KEY, DEFAULT_FROM);
      const result = await service.send({
        to: ['alice@example.com', 'bob@example.com'],
        subject: 'Bulk',
        body: '<p>Hello everyone</p>',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-multi');
      expect(mockEmailsSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['alice@example.com', 'bob@example.com'],
        })
      );
    });

    it('skips Resend call and returns not-configured error when no API key', async () => {
      const service = new EmailService(undefined, DEFAULT_FROM);
      const result = await service.send({
        to: 'charlie@example.com',
        subject: 'Test',
        body: '<p>Test</p>',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('not configured');
      expect(mockEmailsSend).not.toHaveBeenCalled();
    });
  });
});
