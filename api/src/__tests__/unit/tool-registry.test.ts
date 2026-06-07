import { describe, it, expect, vi } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn().mockReturnValue({
      find: vi.fn().mockResolvedValue([]),
    }),
  },
}));

vi.mock('../../llm/rag.service', () => ({
  searchKnowledge: vi.fn(),
}));

vi.mock('../../n8n/booking.service', () => ({
  checkAvailability: vi.fn(),
  createBooking: vi.fn(),
  listBookings: vi.fn(),
  rescheduleBooking: vi.fn(),
  cancelBooking: vi.fn(),
}));

vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: vi.fn(),
  buildEventBase: vi.fn().mockReturnValue({
    id: 'evt-1',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    timestamp: new Date().toISOString(),
    session: { channel: 'widget', visitorId: 'v1', startedAt: new Date().toISOString(), messageCount: 0 },
  }),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { ToolRegistry } from '../../agent/tool-registry';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  it('registers all 8 built-in tools on construction', () => {
    const registry = new ToolRegistry();
    const builtins = registry.getBuiltinToolNames();
    expect(builtins).toContain('kb_search');
    expect(builtins).toContain('check_availability');
    expect(builtins).toContain('create_booking');
    expect(builtins).toContain('list_bookings');
    expect(builtins).toContain('reschedule_booking');
    expect(builtins).toContain('cancel_booking');
    expect(builtins).toContain('escalate_to_human');
    expect(builtins).toContain('capture_lead');
    expect(builtins).toHaveLength(8);
  });

  it('returns KB search + booking tools + escalation for tenant with calcom integration', async () => {
    const registry = new ToolRegistry();
    const tenant = {
      id: 'tenant-1',
      tier: 'pro',
      settings: {
        ai: { enabled: true },
        integrations: { calcom: { apiKey: 'enc_key', eventTypeId: 1 } },
      },
    };
    const tools = await registry.getToolsForTenant(tenant as any, (tenant.settings ?? {}) as any);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('kb_search');
    expect(toolNames).toContain('check_availability');
    expect(toolNames).toContain('create_booking');
    expect(toolNames).toContain('list_bookings');
    expect(toolNames).toContain('reschedule_booking');
    expect(toolNames).toContain('cancel_booking');
    expect(toolNames).toContain('escalate_to_human');
    expect(toolNames).toContain('capture_lead');
  });

  it('excludes booking tools when tenant has no calcom integration', async () => {
    const registry = new ToolRegistry();
    const tenant = { id: 'tenant-2', tier: 'pro', settings: { ai: { enabled: true } } };
    const tools = await registry.getToolsForTenant(tenant as any, (tenant.settings ?? {}) as any);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('kb_search');
    expect(toolNames).toContain('escalate_to_human');
    expect(toolNames).toContain('capture_lead');
    expect(toolNames).not.toContain('check_availability');
    expect(toolNames).not.toContain('create_booking');
    expect(toolNames).not.toContain('list_bookings');
    expect(toolNames).not.toContain('reschedule_booking');
    expect(toolNames).not.toContain('cancel_booking');
  });

  it('includes booking tools for the internal provider on an eligible tier (no Cal.com)', async () => {
    const registry = new ToolRegistry();
    const tenant = {
      id: 'tenant-3',
      tier: 'pro',
      settings: { ai: { enabled: true }, integrations: { provider: 'internal' } },
    };
    const tools = await registry.getToolsForTenant(tenant as any, (tenant.settings ?? {}) as any);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('check_availability');
    expect(toolNames).toContain('create_booking');
    expect(toolNames).toContain('reschedule_booking');
    expect(toolNames).toContain('cancel_booking');
  });

  it('excludes booking tools for the internal provider on an ineligible tier', async () => {
    const registry = new ToolRegistry();
    const tenant = {
      id: 'tenant-4',
      tier: 'free',
      settings: { ai: { enabled: true }, integrations: { provider: 'internal' } },
    };
    const tools = await registry.getToolsForTenant(tenant as any, (tenant.settings ?? {}) as any);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain('check_availability');
    expect(toolNames).not.toContain('create_booking');
  });
});
