import { AppDataSource } from '../database/data-source';
import type { SentimentTrendPoint, SentimentTrendResponse } from '../contracts/insights';

type Sentiment = 'positive' | 'neutral' | 'negative';

export async function getSentimentTrend(
  tenantId: string,
  windowDays: 7 | 30,
  now = new Date(),
): Promise<SentimentTrendResponse> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(today - (windowDays - 1) * 86_400_000);
  const to = new Date(today + 86_400_000);
  const rows: Array<{ date: string; sentiment: Sentiment; count: number | string }> =
    await AppDataSource.query(
      `SELECT (j.session_started_at AT TIME ZONE 'UTC')::date::text AS date,
              j.sentiment,
              COUNT(*)::int AS count
         FROM chatbot_judgments j
        WHERE j.tenant_id = $1
          AND j.sentiment IS NOT NULL
          AND j.session_started_at >= $2
          AND j.session_started_at < $3
        GROUP BY date, j.sentiment
        ORDER BY date ASC`,
      [tenantId, from, to],
    );

  const byDate = new Map<string, SentimentTrendPoint>();
  for (let offset = 0; offset < windowDays; offset += 1) {
    const date = new Date(from.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
    byDate.set(date, { date, positive: 0, neutral: 0, negative: 0 });
  }
  for (const row of rows) {
    const point = byDate.get(row.date);
    if (point && row.sentiment in point) point[row.sentiment] = Number(row.count);
  }

  return { windowDays, timeseries: [...byDate.values()] };
}
