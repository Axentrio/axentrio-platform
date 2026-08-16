import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mocked data-source: the transaction hands the callback a manager whose `query`
// serves the claim SELECT then no-ops the per-row UPDATE; the repository `update`
// records the terminal status writes.
const mockUpdate = vi.fn().mockResolvedValue(undefined);
const mockManagerQuery = vi.fn();
const mockTransaction = vi.fn(async (cb: (m: { query: typeof mockManagerQuery }) => unknown) =>
  cb({ query: mockManagerQuery }),
);

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn(() => ({ update: mockUpdate })),
    transaction: (cb: (m: { query: typeof mockManagerQuery }) => unknown) => mockTransaction(cb),
  },
}));

const mockNotify = vi.fn();
vi.mock('../../services/handoff-notification.service', () => ({
  notifyNewHandoff: (...a: unknown[]) => mockNotify(...a),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  sweepHandoffOutbox,
  deliverHandoffNotification,
} from '../../notifications/notification-outbox.worker';

const PAYLOAD = {
  tenantId: 't1',
  handoffId: 'h1',
  sessionId: 's1',
  reason: 'user_request',
  requestedAt: '2026-08-16T10:00:00.000Z',
};

/** Claim SELECT is the query carrying the lock clause; everything else is an UPDATE. */
function claimReturns(rows: Array<{ id: string; payload: unknown; attempt_count: number }>): void {
  mockManagerQuery.mockImplementation((sql: string) =>
    sql.includes('FOR UPDATE SKIP LOCKED') ? Promise.resolve(rows) : Promise.resolve(undefined),
  );
}

beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue(undefined);
  mockManagerQuery.mockReset();
  mockTransaction.mockClear();
  mockNotify.mockReset().mockResolvedValue(undefined);
});

describe('deliverHandoffNotification (immediate path)', () => {
  it('runs the notify then retires the outbox row', async () => {
    await deliverHandoffNotification({
      tenantId: 't1',
      handoffId: 'h1',
      sessionId: 's1',
      reason: 'user_request',
      requestedAt: new Date(PAYLOAD.requestedAt),
    });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      { kind: 'handoff', relatedId: 'h1', status: 'pending' },
      { status: 'sent', lastError: null },
    );
  });

  it('does NOT retire the row when the notify could not be attempted', async () => {
    mockNotify.mockRejectedValueOnce(new Error('db down'));
    await expect(
      deliverHandoffNotification({
        tenantId: 't1',
        handoffId: 'h1',
        sessionId: 's1',
        reason: 'user_request',
        requestedAt: new Date(),
      }),
    ).rejects.toThrow('db down');
    expect(mockUpdate).not.toHaveBeenCalled(); // row stays pending for the worker
  });
});

describe('sweepHandoffOutbox (backstop)', () => {
  it('dispatches a claimed pending row and marks it sent', async () => {
    claimReturns([{ id: 'o1', payload: PAYLOAD, attempt_count: 0 }]);

    const res = await sweepHandoffOutbox();

    expect(res).toEqual({ dispatched: 1, dead: 0 });
    // Payload rehydrated: reason preserved, requestedAt back to a Date.
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ handoffId: 'h1', reason: 'user_request' }),
    );
    expect(mockNotify.mock.calls[0][0].requestedAt).toBeInstanceOf(Date);
    expect(mockUpdate).toHaveBeenCalledWith({ id: 'o1' }, { status: 'sent', lastError: null });
  });

  it('keeps a row pending (records the error) when dispatch fails under the cap', async () => {
    claimReturns([{ id: 'o1', payload: PAYLOAD, attempt_count: 0 }]); // attempt -> 1, < cap
    mockNotify.mockRejectedValueOnce(new Error('resend 500'));

    const res = await sweepHandoffOutbox();

    expect(res).toEqual({ dispatched: 0, dead: 0 });
    expect(mockUpdate).toHaveBeenCalledWith({ id: 'o1' }, { lastError: 'resend 500' });
    // no status change -> row is still 'pending' and retries after its backoff
    expect(mockUpdate).not.toHaveBeenCalledWith({ id: 'o1' }, expect.objectContaining({ status: 'dead' }));
  });

  it('parks a row as dead once the attempt cap is reached', async () => {
    claimReturns([{ id: 'o1', payload: PAYLOAD, attempt_count: 4 }]); // attempt -> 5 == cap
    mockNotify.mockRejectedValueOnce(new Error('still failing'));

    const res = await sweepHandoffOutbox();

    expect(res).toEqual({ dispatched: 0, dead: 1 });
    expect(mockUpdate).toHaveBeenCalledWith({ id: 'o1' }, { status: 'dead', lastError: 'still failing' });
  });

  it('no-ops (no double run) while a tick is already in flight', async () => {
    claimReturns([]);
    let release!: () => void;
    // Hold the first tick open inside its transaction so the second overlaps it.
    mockTransaction.mockImplementationOnce(async (cb: (m: { query: typeof mockManagerQuery }) => unknown) => {
      await new Promise<void>((r) => (release = r));
      return cb({ query: mockManagerQuery });
    });

    const first = sweepHandoffOutbox();
    const second = await sweepHandoffOutbox(); // in-flight guard short-circuits
    expect(second).toEqual({ dispatched: 0, dead: 0 });
    expect(mockTransaction).toHaveBeenCalledTimes(1); // second never entered the sweep

    release();
    await first;
  });
});
