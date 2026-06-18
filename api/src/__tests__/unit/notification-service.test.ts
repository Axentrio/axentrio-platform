import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (before imports) ──────────────────────────────────────────────────
const mockFind = vi.fn(); // User.find (active operators)
const mockFindOne = vi.fn(); // Notification dedupe lookup
const mockSave = vi.fn();
const mockCreate = vi.fn((e: unknown) => e);

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn(() => ({
      find: mockFind,
      findOne: mockFindOne,
      save: mockSave,
      create: mockCreate,
    })),
  },
}));

vi.mock('../../queue/message-queue', () => ({
  addNotificationJob: vi.fn().mockResolvedValue(undefined),
}));

const mockEmit = vi.fn();
vi.mock('../../websocket/socket.handler', () => ({
  emitToTenantAgents: (...a: unknown[]) => mockEmit(...a),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { notificationService } from '../../services/notification.service';

beforeEach(() => {
  mockFind.mockReset();
  mockFindOne.mockReset();
  mockSave.mockReset();
  mockCreate.mockReset();
  mockEmit.mockReset();
  mockCreate.mockImplementation((e: unknown) => e);
  mockFindOne.mockResolvedValue(null);
  mockSave.mockImplementation((e: Record<string, unknown>) => Promise.resolve({ ...e, id: 'n' }));
});

const input = { tenantId: 't1', type: 'channel.error', title: 'A channel needs attention', message: 'Reconnect it.', data: { connectionId: 'c1' } };

describe('notificationService.createForTenant — desktop WS delivery', () => {
  it('emits ONE tenant-level notification event regardless of recipient count', async () => {
    mockFind.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    await notificationService.createForTenant(input);
    expect(mockSave).toHaveBeenCalledTimes(2); // one row per recipient
    expect(mockEmit).toHaveBeenCalledTimes(1); // but only ONE WS event (not per-row)
    expect(mockEmit).toHaveBeenCalledWith('t1', 'notification', {
      type: 'channel.error',
      title: 'A channel needs attention',
      message: 'Reconnect it.',
      data: { connectionId: 'c1' },
    });
  });

  it('does not emit when the tenant has no active operators', async () => {
    mockFind.mockResolvedValue([]);
    await notificationService.createForTenant(input);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('does not emit when every recipient is deduped (a retry creates no new rows)', async () => {
    mockFind.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    mockFindOne.mockResolvedValue({ id: 'existing' }); // dedupe hit for every recipient
    await notificationService.createForTenant({ ...input, dedupeBase: 'channel:c1' });
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('is best-effort: a socket emit failure does not throw', async () => {
    mockFind.mockResolvedValue([{ id: 'u1' }]);
    mockEmit.mockImplementation(() => {
      throw new Error('socket down');
    });
    await expect(notificationService.createForTenant(input)).resolves.toBeUndefined();
  });
});
