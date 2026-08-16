import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../database/data-source', () => ({
  AppDataSource: { query: (...a: unknown[]) => mockQuery(...a) },
}));

const mockEmit = vi.fn();
vi.mock('../../realtime/conversation-events', () => ({
  emitMessageCreatedForSession: (...a: unknown[]) => mockEmit(...a),
}));

const mockRoute = vi.fn();
vi.mock('../../channels/outbound-router', () => ({
  routeOutboundMessage: (...a: unknown[]) => mockRoute(...a),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  markDeliveryFailed,
  markDeliverySent,
  claimFailedForRetry,
  deliverOperatorReply,
} from '../../channels/delivery-state';

const REPLY = {
  sessionId: 's1',
  tenantId: 't1',
  messageId: 'm1',
  clientMessageId: 'c1',
  content: 'hi',
  createdAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue(undefined);
  mockEmit.mockReset().mockResolvedValue(undefined);
  mockRoute.mockReset();
});

describe('markDeliveryFailed', () => {
  it('sets the message failed and re-emits it as failed, reconciled by clientMessageId', async () => {
    await markDeliveryFailed(REPLY);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), ['m1']);
    expect(mockEmit).toHaveBeenCalledWith(
      's1',
      't1',
      expect.objectContaining({ id: 'm1', status: 'failed', metadata: { clientMessageId: 'c1' } }),
    );
  });
});

describe('markDeliverySent', () => {
  it('clears a claimed (sending) message and emits sent', async () => {
    mockQuery.mockResolvedValueOnce([{ id: 'm1' }]); // one row updated: it was 'sending'
    await markDeliverySent(REPLY);
    expect(mockEmit).toHaveBeenCalledWith('s1', 't1', expect.objectContaining({ status: 'sent' }));
  });

  it('is a no-op for a first successful send (nothing was sending)', async () => {
    mockQuery.mockResolvedValueOnce([]); // no row in 'sending' -> nothing to reconcile
    await markDeliverySent(REPLY);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('claimFailedForRetry', () => {
  it('is true only when a failed row was flipped to sending', async () => {
    mockQuery.mockResolvedValueOnce([{ id: 'm1' }]);
    expect(await claimFailedForRetry('m1')).toBe(true);
    mockQuery.mockResolvedValueOnce([]); // not failed (already delivered / lost the race)
    expect(await claimFailedForRetry('m1')).toBe(false);
  });
});

describe('deliverOperatorReply', () => {
  it('marks failed + emits when the channel rejects the send', async () => {
    mockRoute.mockResolvedValueOnce({ success: false, error: 'token expired' });
    await deliverOperatorReply(REPLY);
    expect(mockRoute).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith('s1', 't1', expect.objectContaining({ status: 'failed' }));
  });

  it('marks failed when the send throws', async () => {
    mockRoute.mockRejectedValueOnce(new Error('network'));
    await deliverOperatorReply(REPLY);
    expect(mockEmit).toHaveBeenCalledWith('s1', 't1', expect.objectContaining({ status: 'failed' }));
  });

  it('does not re-emit on a first successful send', async () => {
    mockRoute.mockResolvedValueOnce({ success: true });
    mockQuery.mockResolvedValueOnce([]); // markDeliverySent: nothing was 'sending'
    await deliverOperatorReply(REPLY);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
