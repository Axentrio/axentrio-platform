/**
 * DB-1: a delivery/read receipt must cost one UPDATE, not a findOne+save per
 * mid. Meta batches every buffered mid into a single webhook, so the per-id
 * loop scaled queries with thread volume.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const db = vi.hoisted(() => ({
  query: vi.fn(async (_sql: string, _params: unknown[]) => [] as unknown[]),
  findOne: vi.fn(async () => null),
  save: vi.fn(async () => undefined),
}));
vi.mock('../../database/data-source', () => {
  // A per-mid loop would reach for the repository; keeping it observable proves
  // the batched path never touches it.
  const repo = { findOne: db.findOne, save: db.save };
  return {
    AppDataSource: { query: db.query, getRepository: vi.fn(() => repo), transaction: vi.fn() },
    getRepository: vi.fn(() => repo),
  };
});

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
}));

import { handleReceiptEvent } from '../../channels/inbound-pipeline';
import type { NormalizedEvent } from '../../channels/types';
import type { ChannelConnection } from '../../database/entities/ChannelConnection';

const CONNECTION = {
  id: 'cccccccc-0000-4000-8000-000000000001',
  tenantId: 'tttttttt-0000-4000-8000-000000000001',
  channel: 'messenger',
} as unknown as ChannelConnection;

function receipt(messageIds: string[], status: 'delivered' | 'read'): NormalizedEvent {
  return {
    type: status === 'read' ? 'read' : 'delivery',
    receipt: { messageIds, status },
    sender: { platformUserId: 'psid-1' },
    dedupeKey: `meta:messenger:page:${status}:1`,
    timestamp: new Date('2026-09-07T10:00:00Z'),
    rawEventType: status,
  } as unknown as NormalizedEvent;
}

describe('handleReceiptEvent · batched delivery update', () => {
  beforeEach(() => {
    db.query.mockClear();
    db.findOne.mockClear();
    db.save.mockClear();
  });

  it('updates a 40-mid receipt with one statement carrying every mid', async () => {
    const mids = Array.from({ length: 40 }, (_, i) => `mid-${i}`);

    await handleReceiptEvent(receipt(mids, 'delivered'), CONNECTION);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE "message_deliveries"/);
    expect(params).toEqual(['delivered', CONNECTION.id, mids]);
    expect(db.findOne).not.toHaveBeenCalled();
    expect(db.save).not.toHaveBeenCalled();
  });

  it('caps a flood of mids at 100 per receipt', async () => {
    const mids = Array.from({ length: 5000 }, (_, i) => `mid-${i}`);

    await handleReceiptEvent(receipt(mids, 'delivered'), CONNECTION);

    expect(db.query).toHaveBeenCalledTimes(1);
    const capped = db.query.mock.calls[0][1][2] as string[];
    expect(capped).toHaveLength(100);
    expect(capped[0]).toBe('mid-0');
    expect(capped[99]).toBe('mid-99');
  });

  it('never demotes a read row to delivered, but a read receipt overwrites', async () => {
    await handleReceiptEvent(receipt(['mid-a'], 'delivered'), CONNECTION);
    expect(db.query.mock.calls[0][0]).toContain(`"status" <> 'read'`);

    db.query.mockClear();
    await handleReceiptEvent(receipt(['mid-a'], 'read'), CONNECTION);
    expect(db.query.mock.calls[0][0]).not.toContain(`"status" <> 'read'`);
  });

  it('issues no write for an empty receipt (Meta read watermarks)', async () => {
    await handleReceiptEvent(receipt([], 'read'), CONNECTION);
    expect(db.query).not.toHaveBeenCalled();
  });
});
