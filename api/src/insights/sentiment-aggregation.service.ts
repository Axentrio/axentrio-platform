/**
 * Sentiment aggregation (P3 / ADR-0014, D5) — folds the last 30 days of
 * sentiment-tagged Judgments into `sentiment` InsightExperiments.
 *
 * A theme surfaces only at ≥3 distinct sessions in the window (recurrence
 * gate, mirrors ADR-0005's ≥3-distinct floor). Below threshold → the
 * experiment is removed UNLESS the tenant dismissed it (dismissed rows
 * persist so they don't re-surface). Experiments are NOT resolvable.
 */
import { AppDataSource } from '../database/data-source';
import { Judgment } from '../database/entities/Judgment';
import { SentimentTheme } from '../database/entities/SentimentTheme';
import { InsightExperiment } from '../database/entities/InsightExperiment';
import { logger } from '../utils/logger';

const WINDOW_DAYS = 30;
const RECURRENCE_FLOOR = 3;
const RED_SESSIONS = 8;

interface ThemeStat {
  themeId: string;
  theme: string;
  polarity: string;
  sessions: number;
  lastAt: Date;
}

export async function aggregateSentiment(tenantId: string, now: Date): Promise<void> {
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Count distinct sessions per theme in the window (judgments are unique per
  // session, so a row count is a distinct-session count).
  const rows: Array<{ themeId: string; theme: string; polarity: string; sessions: string; lastAt: string }> =
    await AppDataSource.getRepository(Judgment)
      .createQueryBuilder('j')
      .select('j.sentiment_theme_id', 'themeId')
      .addSelect('t.theme', 'theme')
      .addSelect('t.polarity', 'polarity')
      .addSelect('COUNT(*)', 'sessions')
      .addSelect('MAX(j.session_started_at)', 'lastAt')
      .innerJoin(SentimentTheme, 't', 't.id = j.sentiment_theme_id')
      .where('j.tenant_id = :tenantId', { tenantId })
      .andWhere('j.sentiment_theme_id IS NOT NULL')
      .andWhere('j.session_started_at >= :windowStart', { windowStart })
      .groupBy('j.sentiment_theme_id')
      .addGroupBy('t.theme')
      .addGroupBy('t.polarity')
      .getRawMany();

  const stats: ThemeStat[] = rows.map((r) => ({
    themeId: r.themeId,
    theme: r.theme,
    polarity: r.polarity,
    sessions: parseInt(r.sessions, 10) || 0,
    lastAt: new Date(r.lastAt),
  }));

  const expRepo = AppDataSource.getRepository(InsightExperiment);
  const existing = await expRepo.find({ where: { tenantId, kind: 'sentiment' } });
  const byFingerprint = new Map(existing.map((e) => [e.fingerprint, e]));

  const qualifying = new Set<string>();

  for (const s of stats) {
    if (s.sessions < RECURRENCE_FLOOR) continue;
    qualifying.add(s.themeId);

    const verb = s.polarity === 'negative' ? 'mention' : s.polarity === 'positive' ? 'praise' : 'mention';
    const title = `Customers frequently ${verb} "${s.theme}" — ${s.sessions} sessions in 30 days`;
    const severity = s.polarity === 'negative' && s.sessions >= RED_SESSIONS ? 'red' : 'orange';

    const gap = byFingerprint.get(s.themeId);
    if (gap) {
      // Upsert: refresh stats, KEEP state (never auto-undismiss).
      gap.title = title;
      gap.severity = severity;
      gap.payload = { theme: s.theme, polarity: s.polarity, sessions: s.sessions };
      gap.lastSeenAt = s.lastAt;
      await expRepo.save(gap);
    } else {
      await expRepo.save(
        expRepo.create({
          tenantId,
          kind: 'sentiment',
          fingerprint: s.themeId,
          severity,
          title,
          detail: null,
          payload: { theme: s.theme, polarity: s.polarity, sessions: s.sessions },
          state: 'active',
          firstSeenAt: s.lastAt,
          lastSeenAt: s.lastAt,
        }),
      );
    }
  }

  // Prune experiments that fell below the floor — but keep dismissed rows
  // (so a dismissed theme doesn't re-surface) and removals are silent.
  for (const e of existing) {
    if (!qualifying.has(e.fingerprint) && e.state !== 'dismissed') {
      await expRepo.remove(e);
    }
  }

  logger.info('[insights-sentiment] aggregated', {
    tenantId,
    themes: stats.length,
    surfaced: qualifying.size,
  });
}
