/**
 * Contract tests for the module catalog + resolver
 * (.scratch/plan-entitlements-modules.md, Phase 2 step 13b — D2/D13/D14/D15).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';

const mockFind = vi.fn();
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn(() => ({ find: mockFind })),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Resolve entitlements through the real pure resolver, driven per test by
// tier/status/overrides — so the D2 precheck and feature gates are the real
// plan-catalog semantics, not stubs.
const entCtx = vi.hoisted(() => ({
  tier: 'pro' as string,
  status: 'active' as string,
  featureOverrides: {} as Record<string, unknown>,
}));
vi.mock('../../billing/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../billing/entitlements')>();
  return {
    ...actual,
    getEntitlements: vi.fn(async () =>
      actual.entitlementsFor(entCtx.tier as never, undefined, {
        status: entCtx.status as never,
        featureOverrides: entCtx.featureOverrides as never,
      })
    ),
  };
});

import {
  registerModule,
  clearCatalogForTests,
  type ModuleDefinition,
} from '../../modules/module-catalog';
import {
  listActiveModules,
  isModuleActive,
  requireModule,
  invalidateModules,
} from '../../modules/module-resolver';
import { bookingModule } from '../../modules/booking.module';
import { PlanLimitError } from '../../billing/enforce';

const TENANT = 'aaaa0000-bbbb-cccc-dddd-eeeeeeee0001';

const bespokeModule: ModuleDefinition = {
  id: 'acme-custom',
  displayName: 'Acme Custom',
  gate: { kind: 'enablement' },
  tools: [],
  configSchema: z.object({ webhookUrl: z.string().url() }),
};

function row(overrides: Partial<{ moduleId: string; enabled: boolean; config: unknown }> = {}) {
  return { moduleId: 'acme-custom', enabled: true, config: { webhookUrl: 'https://acme.test/hook' }, ...overrides };
}

describe('module catalog', () => {
  beforeEach(() => clearCatalogForTests());

  it('throws on duplicate module ids (startup failure)', () => {
    registerModule(bookingModule);
    expect(() => registerModule(bookingModule)).toThrow(/duplicate module id/);
  });
});

describe('module resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCatalogForTests();
    registerModule(bookingModule);
    registerModule(bespokeModule);
    entCtx.tier = 'pro';
    entCtx.status = 'active';
    entCtx.featureOverrides = {};
    mockFind.mockResolvedValue([]);
  });

  describe('feature-gated (booking)', () => {
    it('is active for an entitled tenant with ZERO tenant_modules rows', async () => {
      expect(await isModuleActive(TENANT, 'booking')).toBe(true);
    });

    it('ignores tenant_modules rows entirely — an enabled row cannot activate it below entitlement', async () => {
      entCtx.tier = 'essential'; // bookings=false
      mockFind.mockResolvedValue([row({ moduleId: 'booking', enabled: true, config: {} })]);
      expect(await isModuleActive(TENANT, 'booking')).toBe(false);
    });

    it('follows feature overrides (pro + bookings:false override → inactive)', async () => {
      entCtx.featureOverrides = { bookings: { value: false, reason: 't', setBy: 't', setAt: 't' } };
      expect(await isModuleActive(TENANT, 'booking')).toBe(false);
    });
  });

  describe('enablement-gated (bespoke)', () => {
    it('inactive with no row', async () => {
      expect(await isModuleActive(TENANT, 'acme-custom')).toBe(false);
    });

    it('inactive with enabled=false row', async () => {
      mockFind.mockResolvedValue([row({ enabled: false })]);
      expect(await isModuleActive(TENANT, 'acme-custom')).toBe(false);
    });

    it('active with enabled row + valid config; config is the validated value', async () => {
      mockFind.mockResolvedValue([row()]);
      const active = await listActiveModules(TENANT);
      const acme = active.find((a) => a.module.id === 'acme-custom');
      expect(acme).toBeDefined();
      expect(acme!.config).toEqual({ webhookUrl: 'https://acme.test/hook' });
    });

    it('invalid stored config → inactive (fail closed), other modules unaffected', async () => {
      mockFind.mockResolvedValue([row({ config: { webhookUrl: 'not-a-url' } })]);
      const active = await listActiveModules(TENANT);
      expect(active.some((a) => a.module.id === 'acme-custom')).toBe(false);
      expect(active.some((a) => a.module.id === 'booking')).toBe(true);
    });

    it('does not read entitlement features — active even when every feature is off-tier', async () => {
      entCtx.tier = 'essential'; // no bookings/crm/etc.
      mockFind.mockResolvedValue([row()]);
      expect(await isModuleActive(TENANT, 'acme-custom')).toBe(true);
    });
  });

  describe('D2 — billable precheck activates nothing', () => {
    it('free tier → zero active modules despite enabled rows', async () => {
      entCtx.tier = 'free';
      mockFind.mockResolvedValue([row()]);
      expect(await listActiveModules(TENANT)).toEqual([]);
    });

    it('suspended status → zero active modules despite entitled tier + enabled rows', async () => {
      entCtx.status = 'suspended';
      mockFind.mockResolvedValue([row()]);
      expect(await listActiveModules(TENANT)).toEqual([]);
    });
  });

  describe('fail-closed edges', () => {
    it('unknown module id resolves inactive', async () => {
      expect(await isModuleActive(TENANT, 'does-not-exist')).toBe(false);
    });

    it('requireModule throws the 402 plan-limit envelope when inactive', async () => {
      entCtx.tier = 'essential';
      await expect(requireModule(TENANT, 'booking')).rejects.toBeInstanceOf(PlanLimitError);
      await expect(requireModule(TENANT, 'booking')).rejects.toMatchObject({ statusCode: 402 });
    });

    it('requireModule resolves silently when active', async () => {
      await expect(requireModule(TENANT, 'booking')).resolves.toBeUndefined();
    });

    it('invalidateModules is callable (cache disabled in unit env — no throw)', async () => {
      await expect(invalidateModules(TENANT)).resolves.toBeUndefined();
    });
  });
});
