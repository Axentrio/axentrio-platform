/**
 * Contract tests for the channel gates at the inbound/outbound chokepoints
 * and the Meta connect filtering (.scratch/plan-channel-gating.md — D3/D8/D9/D10).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Entitlement verdict per channel, set by each test.
const entitled = vi.hoisted(() => ({ map: {} as Record<string, boolean> }));
vi.mock('../../channels/channel-entitlement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channels/channel-entitlement')>();
  return {
    ...actual,
    isChannelEntitled: vi.fn(async (_tenantId: string, channel: string) => entitled.map[channel] ?? false),
  };
});

// ── Repo stubs (per entity name) ─────────────────────────────────────────────
const repoStubs = vi.hoisted(() => ({ map: new Map<string, Record<string, ReturnType<typeof vi.fn>>>() }));
function stubRepo(name: string, methods: Record<string, ReturnType<typeof vi.fn>>) {
  repoStubs.map.set(name, methods);
}
vi.mock('../../database/data-source', () => {
  const lookup = (entity: { name?: string } | string) => {
    const name = typeof entity === 'string' ? entity : entity?.name ?? String(entity);
    return repoStubs.map.get(name) ?? {};
  };
  return {
    AppDataSource: { getRepository: vi.fn(lookup), transaction: vi.fn() },
    getRepository: vi.fn(lookup),
  };
});

const emitToSession = vi.fn();
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: (...a: unknown[]) => emitToSession(...a),
}));

const getChannelAdapter = vi.fn();
vi.mock('../../channels/channel-registry', () => ({
  getChannelAdapter: (...a: unknown[]) => getChannelAdapter(...a),
}));

import { routeOutboundMessage } from '../../channels/outbound-router';
import { processInboundEvent } from '../../channels/inbound-pipeline';

const TENANT = 'aaaa0000-bbbb-cccc-dddd-eeeeeeee0001';

describe('outbound gate (D10)', () => {
  const sessionFindOne = vi.fn();
  const connectionFindOne = vi.fn();
  const bindingFindOne = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    entitled.map = {};
    repoStubs.map.clear();
    stubRepo('ChatSession', { findOne: sessionFindOne });
    stubRepo('ChannelConnection', { findOne: connectionFindOne });
    stubRepo('ConversationBinding', { findOne: bindingFindOne });
    stubRepo('MessageDelivery', { create: vi.fn((d) => d), save: vi.fn() });
  });

  const ctx = { sessionId: 's1', tenantId: TENANT, messageId: 'm1' };

  it('unentitled channel → channel_not_entitled; adapter and binding never touched', async () => {
    sessionFindOne.mockResolvedValue({ id: 's1', channel: 'whatsapp', channelConnectionId: 'c1' });
    connectionFindOne.mockResolvedValue({
      id: 'c1', tenantId: TENANT, channel: 'whatsapp', status: 'active', isActive: () => true,
    });
    entitled.map = { whatsapp: false };

    const res = await routeOutboundMessage({ message: 'hi' } as never, ctx);

    expect(res).toEqual({ success: false, error: 'channel_not_entitled' });
    expect(getChannelAdapter).not.toHaveBeenCalled();
    expect(bindingFindOne).not.toHaveBeenCalled();
  });

  it('widget sessions short-circuit without any entitlement read', async () => {
    sessionFindOne.mockResolvedValue({ id: 's1', channel: 'widget', channelConnectionId: null });
    const res = await routeOutboundMessage({ message: 'hi' } as never, ctx);
    expect(res).toEqual({ success: true });
    expect(connectionFindOne).not.toHaveBeenCalled();
  });

  it('entitled channel proceeds into delivery (adapter consulted)', async () => {
    sessionFindOne.mockResolvedValue({ id: 's1', channel: 'whatsapp', channelConnectionId: 'c1' });
    connectionFindOne.mockResolvedValue({
      id: 'c1', tenantId: TENANT, channel: 'whatsapp', status: 'active', isActive: () => true,
    });
    bindingFindOne.mockResolvedValue({ externalThreadId: 'x1' });
    entitled.map = { whatsapp: true };
    getChannelAdapter.mockReturnValue({
      outboundTransport: {
        getCapabilities: () => ({ maxTextLength: 1000, supportsButtons: false, supportsTypingIndicator: false }),
        send: vi.fn().mockResolvedValue({ success: true, platformMessageId: 'pm1' }),
        sendTypingIndicator: vi.fn(),
      },
    });

    const res = await routeOutboundMessage({ message: 'hi' } as never, ctx);
    expect(res.success).toBe(true);
    expect(getChannelAdapter).toHaveBeenCalledWith('whatsapp');
  });
});

describe('inbound gate (D3/D9)', () => {
  const eventLogFindOne = vi.fn();
  const eventLogSave = vi.fn();
  const eventLogCreate = vi.fn((d) => d);
  const bindingFindOne = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    entitled.map = {};
    repoStubs.map.clear();
    stubRepo('WebhookEventLog', { findOne: eventLogFindOne, save: eventLogSave, create: eventLogCreate });
    stubRepo('ConversationBinding', { findOne: bindingFindOne });
  });

  const connection = { id: 'c1', tenantId: TENANT, channel: 'whatsapp' } as never;
  const event = { dedupeKey: 'dk1', type: 'message', rawEventType: 'message', message: { content: 'hi' } } as never;

  it('unentitled channel → event persisted as skipped/channel_not_entitled; no conversation work', async () => {
    eventLogFindOne.mockResolvedValue({ status: 'received', processingAttempts: 0 });
    eventLogSave.mockImplementation(async (e) => e);
    entitled.map = { whatsapp: false };

    await processInboundEvent(event, connection);

    const saved = eventLogSave.mock.calls.map((c) => c[0]);
    expect(saved.some((e) => e.status === 'skipped' && e.error === 'channel_not_entitled')).toBe(true);
    expect(bindingFindOne).not.toHaveBeenCalled(); // findOrCreateConversation never ran
  });

  it('redelivery of a skipped event dedupes terminally (no reprocess)', async () => {
    eventLogFindOne.mockResolvedValue({ status: 'skipped' });
    entitled.map = { whatsapp: false };

    await processInboundEvent(event, connection);

    expect(eventLogSave).not.toHaveBeenCalled(); // returned at the dedupe check
  });
});

describe('setupMetaConnections filtering (D8)', () => {
  it('throws 402 when neither Meta channel is entitled (entitlement changed mid-OAuth)', async () => {
    entitled.map = { messenger: false, instagram: false };
    repoStubs.map.clear();
    stubRepo('ChannelConnection', { findOne: vi.fn(), save: vi.fn(), create: vi.fn((d) => d) });
    vi.doMock('axios', () => ({ default: { post: vi.fn() } }));
    const { setupMetaConnections } = await import('../../channels/meta/setup.service');
    const { PlanLimitError } = await import('../../billing/enforce');

    await expect(
      setupMetaConnections(TENANT, [
        { id: 'p1', name: 'Page', accessToken: 'tok' } as never,
      ]),
    ).rejects.toBeInstanceOf(PlanLimitError);
  });

  it('messenger-only: creates only the messenger connection and reports instagram skipped', async () => {
    entitled.map = { messenger: true, instagram: false };
    repoStubs.map.clear();
    const save = vi.fn(async (d) => d);
    stubRepo('ChannelConnection', { findOne: vi.fn().mockResolvedValue(null), save, create: vi.fn((d) => d) });
    vi.doMock('axios', () => ({ default: { post: vi.fn().mockResolvedValue({}) } }));
    vi.resetModules();
    const { setupMetaConnections } = await import('../../channels/meta/setup.service');

    const result = await setupMetaConnections(TENANT, [
      {
        id: 'p1', name: 'Page', accessToken: 'tok',
        instagramAccount: { id: 'ig1', username: 'shop' },
      } as never,
    ]);

    expect(result.skipped).toEqual(['instagram']);
    expect(result.connections.map((c: { channel: string }) => c.channel)).toEqual(['messenger']);
  });
});
