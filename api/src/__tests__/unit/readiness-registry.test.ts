import { describe, it, expect, beforeEach, vi } from 'vitest';

// The registry is module-state (a Map). Reset modules between tests so each
// gets a fresh registry — otherwise registrations leak across cases.
beforeEach(() => {
  vi.resetModules();
});

describe('readiness registry', () => {
  it('registerCapability + getCapabilities round-trips a contributor', async () => {
    const { registerCapability, getCapabilities } = await import('../../readiness/registry');
    const cap = {
      key: 'booking' as const,
      appliesTo: () => true,
      check: async () => [],
    };
    registerCapability(cap);
    expect(getCapabilities()).toContain(cap);
  });

  it('throws on a duplicate key', async () => {
    const { registerCapability } = await import('../../readiness/registry');
    const a = { key: 'channel' as const, appliesTo: () => true, check: async () => [] };
    const b = { key: 'channel' as const, appliesTo: () => false, check: async () => [] };
    registerCapability(a);
    expect(() => registerCapability(b)).toThrow(/already registered: channel/);
  });

  it('getCapabilities preserves registration order', async () => {
    const { registerCapability, getCapabilities } = await import('../../readiness/registry');
    const a = { key: 'answering' as const, appliesTo: () => true, check: async () => [] };
    const b = { key: 'lead_capture' as const, appliesTo: () => true, check: async () => [] };
    registerCapability(a);
    registerCapability(b);
    expect(getCapabilities().map((c) => c.key)).toEqual(['answering', 'lead_capture']);
  });
});
