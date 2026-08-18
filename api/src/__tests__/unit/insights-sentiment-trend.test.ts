import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../database/data-source', () => ({
  AppDataSource: { query },
}));

import { getSentimentTrend } from '../../insights/sentiment-trend.service';

describe('insights sentiment trend', () => {
  beforeEach(() => query.mockReset());

  it('aggregates sentiment into UTC date buckets and fills empty days', async () => {
    query.mockResolvedValue([
      { date: '2026-08-16', sentiment: 'positive', count: 2 },
      { date: '2026-08-16', sentiment: 'negative', count: 1 },
      { date: '2026-08-18', sentiment: 'neutral', count: 3 },
    ]);

    const result = await getSentimentTrend(
      'tenant-1',
      7,
      new Date('2026-08-18T17:00:00Z'),
    );

    expect(result.timeseries).toHaveLength(7);
    expect(result.timeseries.find((point) => point.date === '2026-08-16')).toEqual({
      date: '2026-08-16',
      positive: 2,
      neutral: 0,
      negative: 1,
    });
    expect(result.timeseries.find((point) => point.date === '2026-08-17')).toEqual({
      date: '2026-08-17',
      positive: 0,
      neutral: 0,
      negative: 0,
    });
    expect(result.timeseries.at(-1)).toEqual({
      date: '2026-08-18',
      positive: 0,
      neutral: 3,
      negative: 0,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("AT TIME ZONE 'UTC'"),
      [
        'tenant-1',
        new Date('2026-08-12T00:00:00.000Z'),
        new Date('2026-08-19T00:00:00.000Z'),
      ],
    );
  });
});
