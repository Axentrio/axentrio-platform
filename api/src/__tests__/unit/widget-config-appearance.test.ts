import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { mockFindOne } = vi.hoisted(() => ({ mockFindOne: vi.fn() }));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({
      findOne: mockFindOne,
    }),
  },
}));

// Attribution now resolves via getEntitlements (DB + cache); resolve through
// the real pure resolver against the scripted tenant so tier semantics stay
// the plan catalog's. `currentTenant` is set by mockResolvedBotAndTenant.
const scripted = vi.hoisted(() => ({ tenant: null as any }));
vi.mock('../../billing/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../billing/entitlements')>();
  return {
    ...actual,
    getEntitlements: vi.fn(async () =>
      actual.entitlementsFor((scripted.tenant?.tier ?? 'free') as never, undefined, {
        status: scripted.tenant?.status,
        featureOverrides: scripted.tenant?.featureOverrides ?? {},
      })
    ),
  };
});

import { widgetRouter } from '../../routes/widget';

// Helper: extract the GET /config route handler from the Express router stack
function findConfigHandler() {
  const layer = (widgetRouter as any).stack.find(
    (l: any) => l.route?.path === '/config' && l.route?.methods?.get,
  );
  if (!layer) throw new Error('Could not locate GET /config handler');
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle;
}

const handler = findConfigHandler();

const makeReq = (apiKey: string) =>
  ({ query: { apiKey }, headers: {} } as unknown as Request);

const makeRes = () => {
  const calls: any[] = [];
  let resolveJson: () => void;
  const jsonCalled = new Promise<void>((resolve) => {
    resolveJson = resolve;
  });
  const res = {} as Response;
  (res as any).status = vi.fn().mockReturnValue(res);
  (res as any).json = vi.fn().mockImplementation((body) => {
    calls.push(body);
    resolveJson();
    return res;
  });
  return { res, calls, jsonCalled };
};

function unwrap(body: any): any {
  // sendSuccess wraps payloads as { success: true, data: ... } — peel it if present
  if (body && typeof body === 'object' && 'data' in body && body.success !== undefined) return body.data;
  return body;
}

beforeEach(() => {
  mockFindOne.mockReset();
});

// resolveBotKey runs Bot.findOne first (looks up by publicKey + tenant
// relation), then falls back to Tenant.findOne. We script both calls.
// #16d: widget config now reads appearance/theme/features/businessHours
// from the resolved bot's settings, so callers can put those on the anchor.
function mockResolvedBotAndTenant(
  tenant: any,
  bot: any | null = null,
  anchorSettings: Record<string, unknown> = {},
) {
  scripted.tenant = tenant;
  // First call (Bot lookup by publicKey)
  mockFindOne.mockResolvedValueOnce(bot);
  if (!bot) {
    // Second call (Bot lookup by previousPublicKey) — miss, fall through to tenant.
    mockFindOne.mockResolvedValueOnce(null);
    // Third call (Tenant lookup by apiKey)
    mockFindOne.mockResolvedValueOnce(tenant);
    // Fourth call (anchor Bot lookup)
    mockFindOne.mockResolvedValueOnce({
      id: 'anchor-bot-id',
      name: 'Anchor',
      status: 'active',
      isDefault: true,
      publicKey: tenant?.apiKey,
      tenant,
      settings: anchorSettings,
    });
  }
}

describe('GET /widget/config — appearance block', () => {
  it('includes appearance with defaults when widget settings absent', async () => {
    mockResolvedBotAndTenant({
      id: 't1',
      name: 'Tenant',
      status: 'active',
      apiKey: 'k',
      settings: {},
    });
    const { res, calls, jsonCalled } = makeRes();
    await handler(makeReq('k'), res, () => {});
    await jsonCalled;
    const body = unwrap(calls[0]);
    expect(body.appearance).toEqual({
      primaryColor: null,
      avatarUrl: null,
      launcherPosition: 'bottom-right',
      launcherLabel: null,
    });
  });

  it('reflects saved widget settings', async () => {
    mockResolvedBotAndTenant(
      {
        id: 't1',
        name: 'Tenant',
        status: 'active',
        apiKey: 'k',
        tier: 'pro',
        settings: {},
      },
      null,
      {
        widget: {
          avatarUrl: 'https://example.com/a.png',
          launcherPosition: 'bottom-left',
          launcherLabel: 'Chat',
        },
      },
    );
    const { res, calls, jsonCalled } = makeRes();
    await handler(makeReq('k'), res, () => {});
    await jsonCalled;
    const body = unwrap(calls[0]);
    expect(body.appearance).toEqual({
      primaryColor: null,
      avatarUrl: 'https://example.com/a.png',
      launcherPosition: 'bottom-left',
      launcherLabel: 'Chat',
    });
  });

  it('carries the saved theme.primaryColor on appearance', async () => {
    mockResolvedBotAndTenant(
      {
        id: 't1',
        name: 'Tenant',
        status: 'active',
        apiKey: 'k',
        settings: {},
      },
      null,
      {
        theme: { primaryColor: '#c41e3a' },
      },
    );
    const { res, calls, jsonCalled } = makeRes();
    await handler(makeReq('k'), res, () => {});
    await jsonCalled;
    const body = unwrap(calls[0]);
    expect(body.appearance.primaryColor).toBe('#c41e3a');
  });

  const tenant = { id: 't1', name: 'Tenant', status: 'active', apiKey: 'k', settings: {} };

  function nonAnchorBot(settings: Record<string, unknown>) {
    return {
      id: 'second-bot-id',
      name: 'Second',
      status: 'active',
      isDefault: false,
      publicKey: 'bk_second',
      tenantId: tenant.id,
      tenant,
      settings,
    };
  }

  function anchorBot(primaryColor: string) {
    return {
      id: 'anchor-bot-id',
      name: 'Anchor',
      status: 'active',
      isDefault: true,
      publicKey: tenant.apiKey,
      tenantId: tenant.id,
      settings: { theme: { primaryColor } },
    };
  }

  it('paints the anchor bot saved colour on a non-anchor bot with no theme', async () => {
    mockResolvedBotAndTenant(tenant, nonAnchorBot({}));
    mockFindOne.mockResolvedValueOnce(anchorBot('#c41e3a'));
    const { res, calls, jsonCalled } = makeRes();
    await handler(makeReq('bk_second'), res, () => {});
    await jsonCalled;
    const body = unwrap(calls[0]);
    expect(body.bot.id).toBe('second-bot-id');
    expect(body.appearance.primaryColor).toBe('#c41e3a');
    expect(mockFindOne).toHaveBeenCalledWith({
      where: expect.objectContaining({ tenantId: 't1', isDefault: true }),
    });
  });

  it('keeps the own saved colour of a non-anchor bot', async () => {
    mockResolvedBotAndTenant(tenant, nonAnchorBot({ theme: { primaryColor: '#0a7e3c' } }));
    mockFindOne.mockResolvedValueOnce(anchorBot('#c41e3a'));
    const { res, calls, jsonCalled } = makeRes();
    await handler(makeReq('bk_second'), res, () => {});
    await jsonCalled;
    const body = unwrap(calls[0]);
    expect(body.bot.id).toBe('second-bot-id');
    expect(body.appearance.primaryColor).toBe('#0a7e3c');
  });

  // D33/D34: Powered-by-Axentrio watermark is gated by tenant tier. Essential
  // shows it (attribution.hide=false), Pro+ hides it (attribution.hide=true).
  it('attribution.hide is false on Essential', async () => {
    mockResolvedBotAndTenant({
      id: 't1',
      name: 'Tenant',
      status: 'active',
      apiKey: 'k',
      tier: 'essential',
      settings: {},
    });
    const { res, calls, jsonCalled } = makeRes();
    await handler(makeReq('k'), res, () => {});
    await jsonCalled;
    const body = unwrap(calls[0]);
    expect(body.attribution).toEqual({ hide: false });
  });

  it('attribution.hide is true on Pro', async () => {
    mockResolvedBotAndTenant({
      id: 't1',
      name: 'Tenant',
      status: 'active',
      apiKey: 'k',
      tier: 'pro',
      settings: {},
    });
    const { res, calls, jsonCalled } = makeRes();
    await handler(makeReq('k'), res, () => {});
    await jsonCalled;
    const body = unwrap(calls[0]);
    expect(body.attribution).toEqual({ hide: true });
  });
});
