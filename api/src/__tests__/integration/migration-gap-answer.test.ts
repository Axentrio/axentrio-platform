/**
 * The Gap-to-answer link, at the schema level.
 *
 * `ON DELETE SET NULL` is not a preference here: the API and the portal both treat
 * `answer_document_id` as "this topic has an answer", so deleting the document has to
 * empty that column. CASCADE would delete the Gap, and NO ACTION would block the delete
 * and leave the card pointing at nothing. `confdeltype = 'n'` is the assertion that says
 * so. The test schema is built by `synchronize`, which does not create this FK (the
 * entity holds a plain column, not a relation), so the migration is run directly.
 */
import { describe, expect, it } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { AddGapAnswer1793200000000 } from '../../database/migrations/1793200000000-AddGapAnswer';

async function answerColumns(): Promise<Array<{ column_name: string; is_nullable: string }>> {
  return AppDataSource.query(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'chatbot_gaps'
      AND column_name IN ('answer_document_id', 'answered_at')
    ORDER BY column_name
  `);
}

async function deleteRule(): Promise<Array<{ confdeltype: string }>> {
  return AppDataSource.query(`
    SELECT confdeltype FROM pg_constraint WHERE conname = 'FK_chatbot_gaps_answer_document'
  `);
}

async function migrate(direction: 'up' | 'down'): Promise<void> {
  const runner = AppDataSource.createQueryRunner();
  try {
    await runner.connect();
    await new AddGapAnswer1793200000000()[direction](runner);
  } finally {
    await runner.release();
  }
}

describe('AddGapAnswer migration', () => {
  it('adds both nullable columns and a SET NULL foreign key, idempotently', async () => {
    await migrate('up');
    // Twice: the deploy runs migrations at boot, and the columns may already exist from
    // `synchronize` in this environment.
    await migrate('up');

    expect(await answerColumns()).toEqual([
      { column_name: 'answer_document_id', is_nullable: 'YES' },
      { column_name: 'answered_at', is_nullable: 'YES' },
    ]);
    expect(await deleteRule()).toEqual([{ confdeltype: 'n' }]);

    await migrate('down');
    expect(await answerColumns()).toEqual([]);
    expect(await deleteRule()).toEqual([]);

    await migrate('up');
  });
});
