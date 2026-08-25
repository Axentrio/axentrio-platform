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

const mockNotifyOverdue = vi.fn();
vi.mock('../../services/handoff-notification.service', () => ({
  notifyOverdueHandoff: (...a: unknown[]) => mockNotifyOverdue(...a),
}));

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({ logger: mockLogger }));

import { sweepOverdueHandoffsAndPauses } from '../../notifications/sla-sweep';

beforeEach(() => {
  mockGetRawMany.mockReset();
  mockCreateForTenant.mockReset();
  mockCreateForTenant.mockResolvedValue(undefined);
  mockNotifyOverdue.mockReset();
  mockNotifyOverdue.mockResolvedValue(undefined);
});

describe('sweepOverdueHandoffsAndPauses', () => {
  it('alerts each overdue source with a bucketed dedupeBase, clamping old backlog to the final bucket', async () => {
    // Every source returns the raw timestamp it is measured from; the sweep
    // derives each age from the app clock, so the DB session time zone cannot
    // skew the age, the wording, or the re-alert bucket.
    const minAgo = (m: number) => new Date(Date.now() - m * 60_000);
    mockGetRawMany
      .mockResolvedValueOnce([{ id: 'hr1', tenantId: 't1', sessionId: 's1', since: minAgo(12) }]) // bucket 0
      .mockResolvedValueOnce([{ id: 's2', tenantId: 't1', sessionId: 's2', since: minAgo(45) }]) // bucket 1
      .mockResolvedValueOnce([
        { id: 's3', tenantId: 't1', sessionId: 's3', since: minAgo(20) }, // pause, bucket 0
        { id: 's4', tenantId: 't1', sessionId: 's4', since: minAgo(200) }, // clamped to bucket 2
      ])
      .mockResolvedValueOnce([{ id: 's5', tenantId: 't2', sessionId: 's5', since: minAgo(15) }]);

    const res = await sweepOverdueHandoffsAndPauses();

    expect(res.alerted).toBe(5); // hr1 + s2 + s3 + s4 (clamped, not skipped) + s5
    expect(mockCreateForTenant).toHaveBeenCalledTimes(5);
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
    // Source 4: a bot that owes a reply. It also logs at error level, because a
    // silent bot is a platform fault and must be visible outside the tenant inbox.
    expect(mockCreateForTenant).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'bot.silent', dedupeBase: 'silent_overdue:s5:0' }),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[sla-sweep] bot owes a reply and never sent one',
      expect.objectContaining({ sessionId: 's5', ageMin: 15 }),
    );

    // #131: overdue HANDOFFS also escalate by email (bucketed); guardrail pauses do not.
    expect(mockNotifyOverdue).toHaveBeenCalledTimes(2);
    expect(mockNotifyOverdue).toHaveBeenCalledWith(
      expect.objectContaining({ overdueId: 'hr1', sessionId: 's1', bucket: 0, ageMinutes: 12 }),
    );
    expect(mockNotifyOverdue).toHaveBeenCalledWith(
      expect.objectContaining({ overdueId: 's2', sessionId: 's2', bucket: 1, ageMinutes: 45 }),
    );
  });

  it('no-ops when nothing is overdue', async () => {
    mockGetRawMany.mockResolvedValue([]);
    const res = await sweepOverdueHandoffsAndPauses();
    expect(res.alerted).toBe(0);
    expect(mockCreateForTenant).not.toHaveBeenCalled();
    expect(mockNotifyOverdue).not.toHaveBeenCalled();
  });
});
