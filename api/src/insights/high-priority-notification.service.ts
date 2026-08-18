import { getEntitlements } from '../billing/entitlements';
import { AppDataSource } from '../database/data-source';
import { Gap } from '../database/entities/Gap';
import { notificationService } from '../services/notification.service';
import { logger } from '../utils/logger';

function alertPeriod(now: Date): string {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (midnight.getUTCDay() + 6) % 7;
  return new Date(midnight.getTime() - daysSinceMonday * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Alert Enterprise operators once per week when open red Gaps exist. */
export async function notifyHighPriorityGaps(tenantId: string, now: Date): Promise<void> {
  try {
    const { features } = await getEntitlements(tenantId);
    if (!features.aiBusinessInsights) return;

    const gaps: Array<{ id: string }> = await AppDataSource.getRepository(Gap)
      .createQueryBuilder('g')
      .select('g.id', 'id')
      .where('g.tenant_id = :tenantId', { tenantId })
      .andWhere("g.status = 'open'")
      .andWhere("g.severity = 'red'")
      .getRawMany();
    if (gaps.length === 0) return;
    const period = alertPeriod(now);

    await notificationService.createForTenant({
      tenantId,
      type: 'insight_gap_high_priority',
      title: `${gaps.length} high-priority ${gaps.length === 1 ? 'issue' : 'issues'} found`,
      message: 'Review these Gaps in Success Meter.',
      data: { gapCount: gaps.length, route: '/success-meter', period },
      dedupeBase: `insight-gap-alert:${tenantId}:${period}`,
    });
  } catch (error) {
    // The next automatic pass retries; notification failure must not block analysis.
    logger.warn('[insights-alert] high-priority notification failed', {
      tenantId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}
