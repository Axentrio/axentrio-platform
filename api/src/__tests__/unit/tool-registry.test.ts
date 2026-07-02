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

vi.mock('../../booking/booking.service', () => ({
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

// Booking tools now gate on resolved entitlements (getEntitlements hits the
// DB + cache). Resolve through the real pure resolver against each test
// tenant's tier so the gate semantics stay the plan catalog's, not a stub's.
const tierById = vi.hoisted(() => new Map<string, string>());
vi.mock('../../billing/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../billing/entitlements')>();
  return {
    ...actual,
    getEntitlements: vi.fn(async (tenantId: string) =>
      actual.entitlementsFor((tierById.get(tenantId) ?? 'free') as never)
    ),
  };
});

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { ToolRegistry } from '../../agent/tool-registry';
import { getEntitlements } from '../../billing/entitlements';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  it('registers all 9 built-in tools on construction', () => {
    const registry = new ToolRegistry();
    const builtins = registry.getBuiltinToolNames();
    expect(builtins).toContain('kb_search');
    expect(builtins).toContain('check_availability');
    expect(builtins).toContain('create_booking');
    expect(builtins).toContain('request_appointment');
    expect(builtins).toContain('list_bookings');
    expect(builtins).toContain('reschedule_booking');
    expect(builtins).toContain('cancel_booking');
    expect(builtins).toContain('escalate_to_human');
    expect(builtins).toContain('capture_lead');
    expect(builtins).toHaveLength(9);
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
    tierById.set(tenant.id, tenant.tier);
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

  it('includes booking tools on an eligible tier even without explicit integration config', async () => {
    // Cal.com is shelved: the internal scheduler is the default backend, so an
    // eligible-tier tenant gets booking tools without any stored integration.
    const registry = new ToolRegistry();
    const tenant = { id: 'tenant-2', tier: 'pro', settings: { ai: { enabled: true } } };
    tierById.set(tenant.id, tenant.tier);
    const tools = await registry.getToolsForTenant(tenant as any, (tenant.settings ?? {}) as any);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('kb_search');
    expect(toolNames).toContain('escalate_to_human');
    expect(toolNames).toContain('capture_lead');
    expect(toolNames).toContain('check_availability');
    expect(toolNames).toContain('create_booking');
    expect(toolNames).toContain('list_bookings');
    expect(toolNames).toContain('reschedule_booking');
    expect(toolNames).toContain('cancel_booking');
  });

  it('includes booking tools for the internal provider on an eligible tier (no Cal.com)', async () => {
    const registry = new ToolRegistry();
    const tenant = {
      id: 'tenant-3',
      tier: 'pro',
      settings: { ai: { enabled: true }, integrations: { provider: 'internal' } },
    };
    tierById.set(tenant.id, tenant.tier);
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
    tierById.set(tenant.id, tenant.tier);
    const tools = await registry.getToolsForTenant(tenant as any, (tenant.settings ?? {}) as any);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain('check_availability');
    expect(toolNames).not.toContain('create_booking');
  });

  it('omits capture_lead when leadCapture is not entitled (free tier) — no false "saved" confirmation', async () => {
    const registry = new ToolRegistry();
    const tenant = { id: 'tenant-free-lead', tier: 'free', settings: { ai: { enabled: true } } };
    tierById.set(tenant.id, tenant.tier);
    const tools = await registry.getToolsForTenant(tenant as any, (tenant.settings ?? {}) as any);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain('capture_lead'); // gated off → tool absent → prompt won't promise a save
    expect(toolNames).toContain('kb_search');          // ungated core capability still loads
    // escalate_to_human is now gated on the handoff entitlement too (LEAK-2 fix) —
    // free tier lacks handoff, so it drops just like capture_lead.
    expect(toolNames).not.toContain('escalate_to_human');
  });

  it('keeps capture_lead for an entitled tier (essential)', async () => {
    const registry = new ToolRegistry();
    const tenant = { id: 'tenant-ess-lead', tier: 'essential', settings: { ai: { enabled: true } } };
    tierById.set(tenant.id, tenant.tier);
    const tools = await registry.getToolsForTenant(tenant as any, (tenant.settings ?? {}) as any);
    expect(tools.map((t) => t.name)).toContain('capture_lead');
  });

  it('fails closed: omits both entitlement-gated tools (keeps ungated core) when the lookup throws', async () => {
    const registry = new ToolRegistry();
    const tenant = { id: 'tenant-ent-err', tier: 'pro', settings: { ai: { enabled: true } } };
    tierById.set(tenant.id, tenant.tier);
    // The two entitlement-gated builtins each call getEntitlements (escalate_to_human,
    // then capture_lead); both must fail closed (omit the tool) on a lookup error.
    vi.mocked(getEntitlements).mockRejectedValueOnce(new Error('redis down')).mockRejectedValueOnce(new Error('redis down'));
    const tools = await registry.getToolsForTenant(tenant as any, (tenant.settings ?? {}) as any);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain('capture_lead');
    expect(toolNames).not.toContain('escalate_to_human');
    expect(toolNames).toContain('kb_search');
  });

  it('keeps booking tools off below Pro+ even with legacy Cal.com config (inert)', async () => {
    // Shelved Cal.com creds left on a sub-Pro bot must not enable booking — the
    // tier gate (calendarSync) is the only thing that matters now.
    const registry = new ToolRegistry();
    const tenant = {
      id: 'tenant-5',
      tier: 'essential',
      settings: { ai: { enabled: true }, integrations: { calcom: { apiKey: 'enc', eventTypeId: 1 } } },
    };
    tierById.set(tenant.id, tenant.tier);
    const tools = await registry.getToolsForTenant(tenant as any, (tenant.settings ?? {}) as any);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain('check_availability');
    expect(toolNames).not.toContain('create_booking');
  });
});
