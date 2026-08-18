import { describe, expect, it, vi } from 'vitest';

vi.mock('../../queue/message-queue', () => ({
  addNotificationJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToUser: vi.fn(),
}));

import { AppDataSource } from '../../database/data-source';
import { CanonicalTopic } from '../../database/entities/CanonicalTopic';
import { Gap } from '../../database/entities/Gap';
import { Notification } from '../../database/entities/Notification';
import { notifyHighPriorityGaps } from '../../insights/high-priority-notification.service';
import { createTestTenant, createTestUser } from '../helpers/factories';

async function addRedGap(tenantId: string, topicName: string) {
  const topic = await AppDataSource.getRepository(CanonicalTopic).save({
    tenantId,
    topic: topicName,
  });
  return AppDataSource.getRepository(Gap).save({
    tenantId,
    canonicalTopicId: topic.id,
    status: 'open',
    severity: 'red',
    occurrences: 7,
    distinctVisitors: 5,
    firstDetectedAt: new Date('2026-08-17T10:00:00Z'),
    lastSeenAt: new Date('2026-08-18T10:00:00Z'),
  });
}

async function seedRedGap(tier: 'pro' | 'enterprise') {
  const tenant = await createTestTenant({ tier });
  await createTestUser(tenant.id, { role: 'admin' });
  const gap = await addRedGap(tenant.id, 'emergency availability');
  return { tenant, gap };
}

describe('Enterprise high-priority Gap notifications', () => {
  it('batches many Gaps, dedupes later hours that week, and allows the next UTC week', async () => {
    const { tenant } = await seedRedGap('enterprise');
    await addRedGap(tenant.id, 'weekend support');
    await addRedGap(tenant.id, 'same-day service');

    await notifyHighPriorityGaps(tenant.id, new Date('2026-08-17T12:00:00Z'));
    await notifyHighPriorityGaps(tenant.id, new Date('2026-08-19T12:00:00Z'));

    const repo = AppDataSource.getRepository(Notification);
    let notifications = await repo.find({
      where: { tenantId: tenant.id, type: 'insight_gap_high_priority' },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: '3 high-priority issues found',
      data: { gapCount: 3, period: '2026-08-17' },
    });
    expect(notifications[0].dedupeKey).toContain(`insight-gap-alert:${tenant.id}:2026-08-17`);

    await notifyHighPriorityGaps(tenant.id, new Date('2026-08-24T12:00:00Z'));
    notifications = await repo.find({
      where: { tenantId: tenant.id, type: 'insight_gap_high_priority' },
    });
    expect(notifications).toHaveLength(2);
    expect(notifications.map((notification) => notification.data?.period).sort()).toEqual([
      '2026-08-17',
      '2026-08-24',
    ]);
  });

  it('does not notify Pro tenants', async () => {
    const { tenant } = await seedRedGap('pro');

    await notifyHighPriorityGaps(tenant.id, new Date('2026-08-18T12:00:00Z'));

    expect(await AppDataSource.getRepository(Notification).count({
      where: { tenantId: tenant.id, type: 'insight_gap_high_priority' },
    })).toBe(0);
  });
});
