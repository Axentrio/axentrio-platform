/**
 * Gap state aggregation — ADR-0005's pain-gated five-state lifecycle,
 * computed from the last 7 days of Judgments after each refresh.
 *
 * Qualifying Pain  = ≥3 distinct visitorIds with an unsatisfied ask in 7d.
 * Positive evidence = ≥3 distinct visitorIds ASKED in 7d AND ≤1 unsatisfied.
 * Allowed transitions only (a single new ask never reopens anything):
 *   open → resolved_data | dormant   (tenant actions add → resolved_manual | archived)
 *   dormant|resolved_data|resolved_manual|archived → open   (full ≥3 bar)
 */
import { AppDataSource } from '../database/data-source';
import { Gap } from '../database/entities/Gap';
import { Judgment } from '../database/entities/Judgment';
import { logger } from '../utils/logger';

const WINDOW_DAYS = 7;
const DORMANCY_DAYS = 14;
const QUALIFYING_VISITORS = 3;
/** Severity is presentation, not lifecycle: red when the pain is broad. */
const RED_VISITORS = 5;

interface TopicWindowStats {
  canonicalTopicId: string;
  askVisitors: Set<string>;
  unsatisfiedVisitors: Set<string>;
  unsatisfiedCount: number;
  lastUnsatisfiedAt: Date | null;
  firstUnsatisfiedAt: Date | null;
}

export async function aggregateGaps(tenantId: string, now: Date): Promise<void> {
  const judgmentRepo = AppDataSource.getRepository(Judgment);
  const gapRepo = AppDataSource.getRepository(Gap);

  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const judgments = await judgmentRepo
    .createQueryBuilder('j')
    .where('j.tenant_id = :tenantId', { tenantId })
    .andWhere('j.session_started_at >= :windowStart', { windowStart })
    .andWhere('j.had_question = true')
    .andWhere('j.canonical_topic_id IS NOT NULL')
    .getMany();

  // Window stats per canonical topic.
  const byTopic = new Map<string, TopicWindowStats>();
  for (const j of judgments) {
    const topicId = j.canonicalTopicId as string;
    let s = byTopic.get(topicId);
    if (!s) {
      s = {
        canonicalTopicId: topicId,
        askVisitors: new Set(),
        unsatisfiedVisitors: new Set(),
        unsatisfiedCount: 0,
        lastUnsatisfiedAt: null,
        firstUnsatisfiedAt: null,
      };
      byTopic.set(topicId, s);
    }
    s.askVisitors.add(j.visitorId);
    if (j.satisfied === false) {
      s.unsatisfiedVisitors.add(j.visitorId);
      s.unsatisfiedCount += 1;
      const at = j.sessionStartedAt;
      if (!s.lastUnsatisfiedAt || at > s.lastUnsatisfiedAt) s.lastUnsatisfiedAt = at;
      if (!s.firstUnsatisfiedAt || at < s.firstUnsatisfiedAt) s.firstUnsatisfiedAt = at;
    }
  }

  const existingGaps = await gapRepo.find({ where: { tenantId } });
  const gapByTopic = new Map(existingGaps.map((g) => [g.canonicalTopicId, g]));

  for (const stats of byTopic.values()) {
    const qualifyingPain = stats.unsatisfiedVisitors.size >= QUALIFYING_VISITORS;
    const positiveEvidence =
      stats.askVisitors.size >= QUALIFYING_VISITORS && stats.unsatisfiedVisitors.size <= 1;
    const severity = stats.unsatisfiedVisitors.size >= RED_VISITORS ? 'red' : 'orange';

    const gap = gapByTopic.get(stats.canonicalTopicId);

    if (!gap) {
      // New fingerprints only ever enter at Qualifying Pain.
      if (qualifyingPain) {
        await gapRepo.save(
          gapRepo.create({
            tenantId,
            canonicalTopicId: stats.canonicalTopicId,
            status: 'open',
            severity,
            occurrences: stats.unsatisfiedCount,
            distinctVisitors: stats.unsatisfiedVisitors.size,
            firstDetectedAt: stats.firstUnsatisfiedAt ?? now,
            lastSeenAt: stats.lastUnsatisfiedAt ?? now,
          }),
        );
      }
      continue;
    }

    // Window counters refresh on every run regardless of state.
    gap.occurrences = stats.unsatisfiedCount;
    gap.distinctVisitors = stats.unsatisfiedVisitors.size;
    if (stats.lastUnsatisfiedAt && stats.lastUnsatisfiedAt > gap.lastSeenAt) {
      gap.lastSeenAt = stats.lastUnsatisfiedAt;
    }

    if (gap.status === 'open') {
      if (positiveEvidence) {
        gap.status = 'resolved_data';
        gap.severity = 'green';
        gap.resolvedAt = now;
      } else if (qualifyingPain) {
        gap.severity = severity;
      }
      // Dormancy is handled in the sweep below (needs absence, not presence).
    } else if (qualifyingPain) {
      // dormant/resolved_data/resolved_manual/archived → open at the full bar.
      logger.info('[insights-gaps] gap reopened', {
        tenantId,
        canonicalTopicId: stats.canonicalTopicId,
        from: gap.status,
      });
      gap.status = 'open';
      gap.severity = severity;
      gap.resolvedAt = null;
      gap.archivedAt = null;
    }

    await gapRepo.save(gap);
  }

  // Dormancy sweep: open gaps with no qualifying pain whose last unsatisfied
  // ask is older than 14 days go dormant. (Proxy for "no qualifying pain for
  // 14 days" — lastSeenAt only advances on unsatisfied asks.)
  const dormancyCutoff = new Date(now.getTime() - DORMANCY_DAYS * 24 * 60 * 60 * 1000);
  for (const gap of existingGaps) {
    if (gap.status !== 'open') continue;
    const stats = byTopic.get(gap.canonicalTopicId);
    const qualifyingPain = (stats?.unsatisfiedVisitors.size ?? 0) >= QUALIFYING_VISITORS;
    if (!qualifyingPain && gap.lastSeenAt < dormancyCutoff) {
      gap.status = 'dormant';
      await gapRepo.save(gap);
    }
  }
}
