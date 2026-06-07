/**
 * Unit tests for the calendar-key rekey logic (P0-2). The rekey SQL references
 * `blocked_range` (a prod-only column not present in the entity-synchronized test
 * DB), so the DB is mocked here and the iteration / conflict handling is asserted
 * directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ query: queryMock }) },
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { rekeyBotBookings, conflictKeyFor } from '../../scheduler/calendar-rekey';

describe('conflictKeyFor', () => {
  it('uses the gcal-prefixed identity when known', () => {
    expect(conflictKeyFor('b1', 'owner@acme.com')).toBe('gcal:owner@acme.com');
  });
  it('falls back to the bot-scoped key when identity is null', () => {
    expect(conflictKeyFor('b1', null)).toBe('bot:b1');
  });
});

describe('rekeyBotBookings', () => {
  beforeEach(() => queryMock.mockReset());

  it('rewrites each active future row to the new key', async () => {
    queryMock
      .mockResolvedValueOnce([
        { id: 'bk1', calendar_key: 'bot:b1' },
        { id: 'bk2', calendar_key: 'bot:b1' },
      ]) // SELECT
      .mockResolvedValue([]); // UPDATEs

    await rekeyBotBookings('b1', 'gcal:owner@acme.com');

    const updates = queryMock.mock.calls.filter((c) => String(c[0]).includes('UPDATE'));
    expect(updates).toHaveLength(2);
    expect(updates[0][1]).toEqual(['gcal:owner@acme.com', 'bk1']);
    expect(updates[1][1]).toEqual(['gcal:owner@acme.com', 'bk2']);
  });

  it('leaves a conflicting row on its old key without throwing (23P01)', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 'bk1', calendar_key: 'bot:b1' }]) // SELECT
      .mockRejectedValueOnce(Object.assign(new Error('exclusion'), { code: '23P01' })); // UPDATE conflict

    await expect(rekeyBotBookings('b1', 'gcal:shared@acme.com')).resolves.toBeUndefined();
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('UPDATE'))).toBe(true);
  });

  it('rethrows non-exclusion DB errors', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 'bk1', calendar_key: 'bot:b1' }])
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '08006' }));
    await expect(rekeyBotBookings('b1', 'gcal:x')).rejects.toThrow('boom');
  });

  it('does nothing when there are no rows to move', async () => {
    queryMock.mockResolvedValueOnce([]); // SELECT
    await rekeyBotBookings('b1', 'gcal:x');
    expect(queryMock.mock.calls.filter((c) => String(c[0]).includes('UPDATE'))).toHaveLength(0);
  });
});
