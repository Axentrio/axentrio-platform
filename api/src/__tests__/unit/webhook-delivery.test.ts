import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

interface LoggedAttempt {
  status: 'success' | 'failed' | 'dropped';
  attempt: number;
  httpStatus?: number;
  error?: string;
  event: string;
  url: string;
  tenantId: string;
}

// vi.hoisted is the supported pattern for sharing state with hoisted vi.mock factories.
const hoisted = vi.hoisted(() => {
  const savedRows: LoggedAttempt[] = [];
  const mockSave = vi.fn(async (row: LoggedAttempt) => {
    savedRows.push(row);
    return row;
  });
  const mockCreate = vi.fn((row: LoggedAttempt) => row);
  const mockGetRepository = vi.fn(() => ({
    save: (row: LoggedAttempt) => mockSave(row),
    create: (row: LoggedAttempt) => mockCreate(row),
  }));
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { savedRows, mockSave, mockCreate, mockGetRepository, mockLogger };
});

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    isInitialized: true,
    getRepository: (...args: unknown[]) => hoisted.mockGetRepository(...(args as [])),
  },
}));

vi.mock('../../database/entities/WebhookDeliveryLog', () => ({
  WebhookDeliveryLog: class WebhookDeliveryLog {},
}));

vi.mock('../../utils/logger', () => ({ logger: hoisted.mockLogger }));

const { savedRows, mockSave, mockCreate, mockGetRepository, mockLogger } = hoisted;

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { deliverWebhook } from '../../webhooks/webhook.dispatcher';
import type { EventWebhookConfig, LeadCreatedEvent } from '../../webhooks/webhook.types';

// ── Helpers ──────────────────────────────────────────────────────────────────

let urlCounter = 0;
function uniqueUrl(): string {
  urlCounter++;
  return `https://hook.test/path-${urlCounter}-${Date.now()}`;
}

function makeConfig(overrides: Partial<EventWebhookConfig> = {}): EventWebhookConfig {
  return {
    url: uniqueUrl(),
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

describe('deliverWebhook (M0 PR10 — outbound delivery logging)', () => {
  beforeEach(() => {
    savedRows.length = 0;
    mockSave.mockClear();
    mockCreate.mockClear();
    mockGetRepository.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    vi.useFakeTimers();
  });

  it('success path: persists one row with status=success, attempt=1', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig();
    const event = makeEvent();

    const promise = deliverWebhook(config, event);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(savedRows).toHaveLength(1);
    expect(savedRows[0]).toMatchObject({
      status: 'success',
      attempt: 1,
      httpStatus: 200,
      event: 'lead.created',
      tenantId: 'tenant-001',
    });
    // No dead-letter on success
    expect(
      mockLogger.error.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('webhook_dead_letter'),
      ),
    ).toBe(false);
  });

  it('transient failure then success: two failed rows + one success row', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig();
    const event = makeEvent();

    const promise = deliverWebhook(config, event);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(savedRows).toHaveLength(3);

    expect(savedRows[0]).toMatchObject({ status: 'failed', attempt: 1, httpStatus: 503 });
    expect(savedRows[1]).toMatchObject({ status: 'failed', attempt: 2, httpStatus: 502 });
    expect(savedRows[2]).toMatchObject({ status: 'success', attempt: 3, httpStatus: 200 });

    // No dead-letter on eventual success
    expect(
      mockLogger.error.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('webhook_dead_letter'),
      ),
    ).toBe(false);
  });

  it('permanent failure: three failed rows (attempt 1,2,3) + dead-letter log', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig();
    const event = makeEvent();

    const promise = deliverWebhook(config, event);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(savedRows).toHaveLength(3);
    expect(savedRows.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(savedRows.every((r) => r.status === 'failed')).toBe(true);
    expect(savedRows.every((r) => r.httpStatus === 500)).toBe(true);

    // Structured dead-letter log present on the 3rd failure
    const deadLetterCalls = mockLogger.error.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0] === 'webhook_dead_letter',
    );
    expect(deadLetterCalls).toHaveLength(1);
    expect(deadLetterCalls[0][1]).toMatchObject({
      reason: 'webhook_dead_letter',
      eventType: 'lead.created',
      tenantId: 'tenant-001',
      attempts: 3,
    });
  });

  it('network timeout dead-letters after 3 attempts', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const mockFetch = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig();
    const event = makeEvent();

    const promise = deliverWebhook(config, event);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(savedRows).toHaveLength(3);
    expect(savedRows.every((r) => r.status === 'failed' && r.error === 'timeout')).toBe(true);

    const deadLetterCalls = mockLogger.error.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0] === 'webhook_dead_letter',
    );
    expect(deadLetterCalls).toHaveLength(1);
  });

  it('4xx client error: one failed row, no retries, no dead-letter', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig();
    const event = makeEvent();

    const promise = deliverWebhook(config, event);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(savedRows).toHaveLength(1);
    expect(savedRows[0]).toMatchObject({ status: 'failed', attempt: 1, httpStatus: 400 });

    expect(
      mockLogger.error.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0] === 'webhook_dead_letter',
      ),
    ).toBe(false);
  });
});
