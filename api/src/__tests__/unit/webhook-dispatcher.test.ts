import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Stub the persistence path — exercised in detail by webhook-delivery.test.ts
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    isInitialized: true,
    getRepository: vi.fn(() => ({
      save: vi.fn().mockResolvedValue(undefined),
      create: vi.fn((row: unknown) => row),
    })),
  },
}));

vi.mock('../../database/entities/WebhookDeliveryLog', () => ({
  WebhookDeliveryLog: class WebhookDeliveryLog {},
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { deliverWebhook } from '../../webhooks/webhook.dispatcher';
import type { EventWebhookConfig, LeadCreatedEvent } from '../../webhooks/webhook.types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<EventWebhookConfig> = {}): EventWebhookConfig {
  return {
    url: 'https://example.com/hook',
    events: ['lead.created'],
    secret: 'test-secret',
    enabled: true,
    ...overrides,
  };
}

function makeEvent(): LeadCreatedEvent {
  return {
    id: 'evt-001',
    type: 'lead.created',
    tenantId: 'tenant-001',
    sessionId: 'sess-001',
    timestamp: '2026-04-03T00:00:00.000Z',
    session: {
      channel: 'web',
      visitorId: 'visitor-001',
      startedAt: '2026-04-03T00:00:00.000Z',
      messageCount: 5,
    },
    lead: { name: 'Alice', email: 'alice@example.com', source: 'chat' },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('deliverWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('delivers webhook with correct HMAC signature and headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig();
    const event = makeEvent();

    const promise = deliverWebhook(config, event);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(config.url);
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['X-Webhook-Event']).toBe('lead.created');
    expect(headers['X-Webhook-Id']).toBe('evt-001');
    expect(headers['X-Webhook-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(headers['Content-Type']).toBe('application/json');

    // Verify HMAC is deterministic
    const { createHmac } = await import('crypto');
    const body = JSON.stringify(event);
    const expected = `sha256=${createHmac('sha256', config.secret).update(body).digest('hex')}`;
    expect(headers['X-Webhook-Signature']).toBe(expected);
  });

  it('retries up to 3 times on 500 errors then gives up', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig();
    const event = makeEvent();

    const promise = deliverWebhook(config, event);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on 400 client errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig();
    const event = makeEvent();

    const promise = deliverWebhook(config, event);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('handles network timeout gracefully without throwing', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const mockFetch = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig();
    const event = makeEvent();

    const promise = deliverWebhook(config, event);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();

    // All 3 retries attempted
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
