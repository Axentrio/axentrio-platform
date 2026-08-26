/**
 * Integration: pruneRemovedDocs — the corpus-sync half of hydration.
 *
 * hydrate.ts upserts every doc in the bundle but must also REMOVE rows for docs
 * that left the bundle (a deleted file, a renamed slug). Without this the
 * retriever keeps serving a doc that no longer exists in source — e.g. a shelved
 * integration — which is the exact wrong-information failure this guards.
 *
 * DB-only and deterministic: it seeds its own rows and never reads the built
 * bundle, so it cannot pass-or-fail on whether `npm run build` ran first.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { pruneRemovedDocs } from '../../copilot/hydrate';

async function seedDoc(slug: string, locale: string): Promise<void> {
  await AppDataSource.query(
    `INSERT INTO chatbot_copilot_docs (slug, locale, title, body, tags, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [slug, locale, `${slug} ${locale}`, 'body', ['t'], `hash-${slug}-${locale}`],
  );
}

async function currentKeys(): Promise<Array<{ slug: string; locale: string }>> {
  return AppDataSource.query(
    `SELECT slug, locale FROM chatbot_copilot_docs ORDER BY slug, locale`,
  );
}

describe('pruneRemovedDocs', () => {
  beforeEach(async () => {
    await AppDataSource.query('DELETE FROM chatbot_copilot_docs');
  });

  it('removes rows absent from the keep-set and keeps the rest', async () => {
    await seedDoc('kept-a', 'en');
    await seedDoc('kept-b', 'fr');
    await seedDoc('stale', 'en');

    const removed = await AppDataSource.transaction((m) =>
      pruneRemovedDocs(m, [
        { slug: 'kept-a', locale: 'en' },
        { slug: 'kept-b', locale: 'fr' },
      ]),
    );

    expect(removed).toEqual([{ slug: 'stale', locale: 'en' }]);
    expect(await currentKeys()).toEqual([
      { slug: 'kept-a', locale: 'en' },
      { slug: 'kept-b', locale: 'fr' },
    ]);
  });

  it('matches on (slug, locale) as a pair — a kept slug in one locale does not save its other locales', async () => {
    await seedDoc('doc', 'en');
    await seedDoc('doc', 'fr');
    await seedDoc('doc', 'nl');

    const removed = await AppDataSource.transaction((m) =>
      pruneRemovedDocs(m, [{ slug: 'doc', locale: 'en' }]),
    );

    expect(removed.sort((a, b) => a.locale.localeCompare(b.locale))).toEqual([
      { slug: 'doc', locale: 'fr' },
      { slug: 'doc', locale: 'nl' },
    ]);
    expect(await currentKeys()).toEqual([{ slug: 'doc', locale: 'en' }]);
  });

  it('never wipes the corpus when the keep-set is empty (fail safe)', async () => {
    await seedDoc('a', 'en');
    await seedDoc('b', 'en');

    const removed = await AppDataSource.transaction((m) => pruneRemovedDocs(m, []));

    expect(removed).toEqual([]);
    expect(await currentKeys()).toHaveLength(2);
  });
});
