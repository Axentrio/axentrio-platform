import { describe, expect, it } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { RemoveGapRecommendation1792300000000 } from '../../database/migrations/1792300000000-RemoveGapRecommendation';

async function recommendationColumns(): Promise<Array<{ data_type: string }>> {
  return AppDataSource.query(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'chatbot_gaps'
      AND column_name = 'recommendation'
  `);
}

async function migrate(direction: 'up' | 'down'): Promise<void> {
  const runner = AppDataSource.createQueryRunner();
  try {
    await runner.connect();
    await new RemoveGapRecommendation1792300000000()[direction](runner);
  } finally {
    await runner.release();
  }
}

describe('RemoveGapRecommendation migration', () => {
  it('drops the dead column idempotently and restores it on rollback', async () => {
    await AppDataSource.query(`
      ALTER TABLE "chatbot_gaps"
        ADD COLUMN IF NOT EXISTS "recommendation" text
    `);

    await migrate('up');
    await migrate('up');
    expect(await recommendationColumns()).toEqual([]);

    await migrate('down');
    expect(await recommendationColumns()).toEqual([{ data_type: 'text' }]);

    await migrate('up');
  });
});
