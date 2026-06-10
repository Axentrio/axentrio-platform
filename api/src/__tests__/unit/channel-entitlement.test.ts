/**
 * Contract tests for per-channel entitlement gating
 * (.scratch/plan-channel-gating.md — D1/D2/D12 + the mapping helper).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Resolve entitlements via the real pure resolver, driven per test.
const entCtx = vi.hoisted(() => ({
  tier: 'pro' as string,
  status: 'active' as string,
  featureOverrides: {} as Record<string, unknown>,
  fail: false,
}));
vi.mock('../../billing/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../billing/entitlements')>();
  return {
    ...actual,
    getEntitlements: vi.fn(async () => {
      if (entCtx.fail) throw new Error('redis down');
      return actual.entitlementsFor(entCtx.tier as never, undefined, {
        status: entCtx.status as never,
        featureOverrides: entCtx.featureOverrides as never,
      });
    }),
  };
});

import {
  channelFeatureKey,
  isChannelEntitled,
  requireChannelEntitled,
  requireAnyMetaChannelEntitled,
} from '../../channels/channel-entitlement';
import { PLANS } from '../../billing/plans';
import { entitlementsFor } from '../../billing/entitlements';
import { PlanLimitError } from '../../billing/enforce';

const TENANT = 'aaaa0000-bbbb-cccc-dddd-eeeeeeee0001';

function reset(tier = 'pro', status = 'active') {
  entCtx.tier = tier;
  entCtx.status = status;
  entCtx.featureOverrides = {};
  entCtx.fail = false;
}

describe('plan catalog — channel keys (D2)', () => {
  it.each(['channelWhatsapp', 'channelMessenger', 'channelInstagram', 'channelTelegram'] as const)(
    '%s: false on free/essential, true on pro/enterprise',
    (key) => {
      expect(PLANS.free.features[key]).toBe(false);
      expect(PLANS.essential.features[key]).toBe(false);
      expect(PLANS.pro.features[key]).toBe(true);
      expect(PLANS.enterprise.features[key]).toBe(true);
    },
  );

  it('D2 deny: suspended pro tenant loses all channels', () => {
    const e = entitlementsFor('pro', undefined, { status: 'suspended', featureOverrides: {} });
    expect(e.features.channelWhatsapp).toBe(false);
    expect(e.features.channelTelegram).toBe(false);
  });
});

describe('channelFeatureKey — widget vs unknown are distinct (D12)', () => {
  it('widget → ungated (never a key, never null)', () => {
    expect(channelFeatureKey('widget')).toBe('ungated');
  });

  it('each external channel maps to its key', () => {
    expect(channelFeatureKey('whatsapp')).toBe('channelWhatsapp');
    expect(channelFeatureKey('messenger')).toBe('channelMessenger');
    expect(channelFeatureKey('instagram')).toBe('channelInstagram');
    expect(channelFeatureKey('telegram')).toBe('channelTelegram');
  });

  it('unknown channel type → null (fail closed downstream)', () => {
    expect(channelFeatureKey('carrier-pigeon' as never)).toBeNull();
  });
});

describe('isChannelEntitled', () => {
  it('widget is always entitled — even on essential', async () => {
    reset('essential');
    expect(await isChannelEntitled(TENANT, 'widget')).toBe(true);
  });

  it('essential: external channels not entitled; pro: entitled', async () => {
    reset('essential');
    expect(await isChannelEntitled(TENANT, 'whatsapp')).toBe(false);
    reset('pro');
    expect(await isChannelEntitled(TENANT, 'whatsapp')).toBe(true);
  });

  it('per-tenant override comps a channel onto essential', async () => {
    reset('essential');
    entCtx.featureOverrides = {
      channelWhatsapp: { value: true, reason: 't', setBy: 't', setAt: 't' },
    };
    expect(await isChannelEntitled(TENANT, 'whatsapp')).toBe(true);
    expect(await isChannelEntitled(TENANT, 'telegram')).toBe(false); // not implied
  });

  it('unknown channel → false; resolution error → false (fail closed)', async () => {
    reset('pro');
    expect(await isChannelEntitled(TENANT, 'carrier-pigeon' as never)).toBe(false);
    entCtx.fail = true;
    expect(await isChannelEntitled(TENANT, 'whatsapp')).toBe(false);
  });
});

describe('requireChannelEntitled (connect-time gate)', () => {
  it('throws the 402 envelope with a per-channel code on essential', async () => {
    reset('essential');
    await expect(requireChannelEntitled(TENANT, 'telegram')).rejects.toBeInstanceOf(PlanLimitError);
    await expect(requireChannelEntitled(TENANT, 'telegram')).rejects.toMatchObject({
      statusCode: 402,
      code: 'plan_limit_channel_telegram',
    });
  });

  it('no-op for widget and for entitled channels', async () => {
    reset('essential');
    await expect(requireChannelEntitled(TENANT, 'widget')).resolves.toBeUndefined();
    reset('pro');
    await expect(requireChannelEntitled(TENANT, 'whatsapp')).resolves.toBeUndefined();
  });

  it('unknown channel type → 402 (fail closed)', async () => {
    reset('pro');
    await expect(requireChannelEntitled(TENANT, 'carrier-pigeon' as never)).rejects.toMatchObject({
      statusCode: 402,
    });
  });
});

describe('requireAnyMetaChannelEntitled (shared OAuth flow gate)', () => {
  it('402 when neither Messenger nor Instagram is entitled', async () => {
    reset('essential');
    await expect(requireAnyMetaChannelEntitled(TENANT)).rejects.toMatchObject({
      statusCode: 402,
      code: 'plan_limit_channel_meta',
    });
  });

  it('passes with either one comped via override', async () => {
    reset('essential');
    entCtx.featureOverrides = {
      channelInstagram: { value: true, reason: 't', setBy: 't', setAt: 't' },
    };
    await expect(requireAnyMetaChannelEntitled(TENANT)).resolves.toBeUndefined();
  });

  it('passes on pro (both entitled)', async () => {
    reset('pro');
    await expect(requireAnyMetaChannelEntitled(TENANT)).resolves.toBeUndefined();
  });
});
