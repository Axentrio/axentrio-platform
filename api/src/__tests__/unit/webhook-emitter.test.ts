import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

const mockFindOne = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn(() => ({ findOne: mockFindOne })),
  },
}));

const mockDeliverWebhook = vi.fn().mockResolvedValue(undefined);

vi.mock('../../webhooks/webhook.dispatcher', () => ({
  deliverWebhook: (...args: any[]) => mockDeliverWebhook(...args),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../database/entities/Tenant', () => ({ Tenant: class Tenant {} }));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { emitWebhookEvent } from '../../webhooks/webhook.emitter';
import type { LeadCreatedEvent } from '../../webhooks/webhook.types';

// ── Helpers ──────────────────────────────────────────────────────────────────

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
      messageCount: 3,
    },
    lead: { name: 'Bob', email: 'bob@example.com', source: 'chat' },
  };
}

function makeTenantWith(eventWebhooks: any[]) {
  return { id: 'tenant-001', settings: { eventWebhooks } };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('emitWebhookEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches to matching enabled webhook configs', async () => {
    const config = { url: 'https://hook.example.com', events: ['lead.created'], secret: 'sec', enabled: true };
    mockFindOne.mockResolvedValue(makeTenantWith([config]));

    emitWebhookEvent(makeEvent());

    // Allow the async fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 0));

    expect(mockDeliverWebhook).toHaveBeenCalledOnce();
    expect(mockDeliverWebhook.mock.calls[0][0]).toMatchObject({ url: 'https://hook.example.com' });
  });

  it('skips disabled webhook configs', async () => {
    const config = { url: 'https://hook.example.com', events: ['lead.created'], secret: 'sec', enabled: false };
    mockFindOne.mockResolvedValue(makeTenantWith([config]));

    emitWebhookEvent(makeEvent());
    await new Promise((r) => setTimeout(r, 0));

    expect(mockDeliverWebhook).not.toHaveBeenCalled();
  });

  it('skips configs that do not include the event type', async () => {
    const config = { url: 'https://hook.example.com', events: ['appointment.booked'], secret: 'sec', enabled: true };
    mockFindOne.mockResolvedValue(makeTenantWith([config]));

    emitWebhookEvent(makeEvent()); // event type is 'lead.created'
    await new Promise((r) => setTimeout(r, 0));

    expect(mockDeliverWebhook).not.toHaveBeenCalled();
  });

  it('does nothing when tenant has no eventWebhooks', async () => {
    mockFindOne.mockResolvedValue({ id: 'tenant-001', settings: {} });

    emitWebhookEvent(makeEvent());
    await new Promise((r) => setTimeout(r, 0));

    expect(mockDeliverWebhook).not.toHaveBeenCalled();
  });
});
