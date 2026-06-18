import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetRawMany = vi.fn();
const mockQb = {
  select: vi.fn(() => mockQb),
  addSelect: vi.fn(() => mockQb),
  innerJoin: vi.fn(() => mockQb),
  where: vi.fn(() => mockQb),
  andWhere: vi.fn(() => mockQb),
  limit: vi.fn(() => mockQb),
  getRawMany: mockGetRawMany,
};

vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: vi.fn(() => ({ createQueryBuilder: () => mockQb })) },
}));

const mockCreateForTenant = vi.fn();
vi.mock('../../services/notification.service', () => ({
  notificationService: { createForTenant: (...a: unknown[]) => mockCreateForTenant(...a) },
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { sweepOverdueHandoffsAndPauses } from '../../notifications/sla-sweep';

beforeEach(() => {
  mockGetRawMany.mockReset();
  mockCreateForTenant.mockReset();
  mockCreateForTenant.mockResolvedValue(undefined);
});

describe('sweepOverdueHandoffsAndPauses', () => {
  it('alerts each overdue source with a bucketed dedupeBase, clamping old backlog to the final bucket', async () => {
    mockGetRawMany
      .mockResolvedValueOnce([{ id: 'hr1', tenantId: 't1', sessionId: 's1', ageMin: '12' }]) // handoff_request, bucket 0
      .mockResolvedValueOnce([{ id: 's2', tenantId: 't1', sessionId: 's2', ageMin: '45' }]) // session-only handoff, bucket 1
      .mockResolvedValueOnce([
        { id: 's3', tenantId: 't1', sessionId: 's3', ageMin: '20' }, // pause, bucket 0
        { id: 's4', tenantId: 't1', sessionId: 's4', ageMin: '200' }, // pause, clamped to bucket 2 (still alerts once)
      ]);

    const res = await sweepOverdueHandoffsAndPauses();

    expect(res.alerted).toBe(4); // hr1 + s2 + s3 + s4 (backlog clamped, not skipped)
    expect(mockCreateForTenant).toHaveBeenCalledTimes(4);
    expect(mockCreateForTenant).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'handoff.overdue', dedupeBase: 'handoff_overdue:hr1:0' }),
    );
    // session-only handoff carries no real handoff id
    expect(mockCreateForTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'handoff.overdue',
        dedupeBase: 'handoff_overdue:s2:1',
        data: expect.objectContaining({ sessionId: 's2', handoffId: null }),
      }),
    );
    expect(mockCreateForTenant).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'guardrail.overdue', dedupeBase: 'guardrail_overdue:s3:0' }),
    );
    expect(mockCreateForTenant).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'guardrail.overdue', dedupeBase: 'guardrail_overdue:s4:2' }),
    );
  });

  it('no-ops when nothing is overdue', async () => {
    mockGetRawMany.mockResolvedValue([]);
    const res = await sweepOverdueHandoffsAndPauses();
    expect(res.alerted).toBe(0);
    expect(mockCreateForTenant).not.toHaveBeenCalled();
  });
});
