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
  ({ query: { apiKey } } as unknown as Request);

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
  // First call (Bot lookup by publicKey)
  mockFindOne.mockResolvedValueOnce(bot);
  // Second call (Tenant lookup by apiKey) — only fires if bot is null
  mockFindOne.mockResolvedValueOnce(tenant);
  // Third call (anchor Bot lookup) — fires when tenant matched
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
      avatarUrl: 'https://example.com/a.png',
      launcherPosition: 'bottom-left',
      launcherLabel: 'Chat',
    });
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
