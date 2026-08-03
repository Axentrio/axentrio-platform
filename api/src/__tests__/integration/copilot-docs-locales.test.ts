/**
 * The Dutch and French Copilot corpus.
 *
 * Two things can go wrong with translated docs, and only one of them is obvious.
 *
 * The obvious one is a MISSING translation — an English doc added later with no `.nl`
 * or `.fr` sibling. Retrieval silently falls back to English, so a Dutch customer gets
 * an English answer and nobody notices until they complain.
 *
 * The subtle one is a translation that exists but cannot be FOUND. Retrieval is
 * pg_trgm `word_similarity` over `title || body`, so a doc is only reachable through
 * the words it actually contains. A faithful translation that renders "leads" as
 * something nobody types, or drops the product noun a customer would search for, is
 * invisible — present in the corpus, absent from every answer.
 *
 * So this loads the real corpus and asks it real questions in each language.
 *
 * It reads the SOURCE markdown, not `dist/copilot/docs-bundle.json`. Reading the build
 * artifact passed locally, where a build had been run by hand, and failed in CI, where
 * `api-test` runs npm ci, tsc and vitest and never builds — which took main red and
 * skipped the deploy.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { LexicalCopilotKnowledgeSource } from '../../copilot/knowledge/lexical';
import { loadDocsFromSource, type DocEntry } from '../../copilot/docs-source';

let docs: DocEntry[];

beforeAll(async () => {
  docs = await loadDocsFromSource();
});

const slugsFor = (locale: string) =>
  new Set(docs.filter((e) => e.locale === locale).map((e) => e.slug));

describe('corpus parity', () => {
  it('has a Dutch and French doc for every English one', () => {
    // A gap here is invisible at runtime: retrieval falls back to English and the
    // customer just gets the wrong language.
    const en = slugsFor('en');
    expect(en.size).toBeGreaterThan(20);
    expect([...en].filter((s) => !slugsFor('nl').has(s))).toEqual([]);
    expect([...en].filter((s) => !slugsFor('fr').has(s))).toEqual([]);
  });

  it('translates the title rather than shipping the English one', () => {
    // A doc whose title never changed is a doc that was never translated.
    const byKey = new Map(docs.map((e) => [`${e.slug}|${e.locale}`, e]));
    const untranslated: string[] = [];
    for (const slug of slugsFor('en')) {
      const en = byKey.get(`${slug}|en`)!;
      for (const loc of ['nl', 'fr']) {
        if (byKey.get(`${slug}|${loc}`)!.title === en.title) untranslated.push(`${slug}.${loc}`);
      }
    }
    expect(untranslated).toEqual([]);
  });

  it('keeps the tag vocabulary identical across locales', () => {
    // Tags are metadata, not prose — translating them would fragment the vocabulary
    // for no gain, since search never reads them.
    const byKey = new Map(docs.map((e) => [`${e.slug}|${e.locale}`, e]));
    for (const slug of slugsFor('en')) {
      const en = byKey.get(`${slug}|en`)!;
      for (const loc of ['nl', 'fr']) {
        expect(byKey.get(`${slug}|${loc}`)!.tags, `${slug}.${loc}`).toEqual(en.tags);
      }
    }
  });
});

describe('retrieval in each language', () => {
  let source: LexicalCopilotKnowledgeSource;

  // Seeded per test, not once: the suite truncates between tests, so a beforeAll
  // fixture is gone by the second case — and an empty corpus makes every retrieval
  // assertion below vacuously "nothing found" rather than a real result.
  beforeEach(async () => {
    await AppDataSource.query('DELETE FROM chatbot_copilot_docs');
    for (const e of docs) {
      await AppDataSource.query(
        `INSERT INTO chatbot_copilot_docs (slug, locale, title, body, tags, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.slug, e.locale, e.title, e.body, e.tags, e.contentHash],
      );
    }
    source = new LexicalCopilotKnowledgeSource(AppDataSource.manager);
  });

  /** Questions a real customer would type, and the doc that should answer them. */
  const QUESTIONS: Array<['nl' | 'fr', string, string]> = [
    ['nl', 'hoe installeer ik de widget op mijn website', 'installing-the-widget'],
    ['nl', 'waarom antwoordt mijn bot niet', 'why-bot-not-replying'],
    ['nl', 'hoe zeg ik mijn abonnement op', 'cancelling-your-subscription'],
    ['nl', 'waar vind ik mijn facturen', 'invoice-and-billing'],
    ['nl', 'hoe koppel ik whatsapp en instagram', 'connecting-social-channels'],
    ['nl', 'er worden geen leads vastgelegd', 'why-no-leads-captured'],
    ['nl', 'hoe lang duurt mijn proefperiode', 'understanding-trial'],
    ['fr', 'comment installer le widget sur mon site', 'installing-the-widget'],
    ['fr', 'pourquoi mon bot ne répond pas', 'why-bot-not-replying'],
    ['fr', 'comment résilier mon abonnement', 'cancelling-your-subscription'],
    ['fr', 'où trouver mes factures', 'invoice-and-billing'],
    ['fr', 'comment connecter whatsapp et instagram', 'connecting-social-channels'],
    ['fr', 'aucun lead enregistré', 'why-no-leads-captured'],
    ['fr', "combien de temps dure ma période d'essai", 'understanding-trial'],
  ];

  it.each(QUESTIONS)('[%s] "%s" finds %s', async (locale, query, expectedSlug) => {
    const hits = await source.search(query, locale, 5);
    expect(hits.length, 'no documents matched at all').toBeGreaterThan(0);

    // Served from the asked-for language, not the English fallback.
    expect(hits[0].locale).toBe(locale);
    expect(hits.map((h) => h.slug)).toContain(expectedSlug);
  });

  it('falls back to English only when the language genuinely has nothing', async () => {
    // The fallback is a safety net, not the normal path — if it fires for ordinary
    // questions, the translations are not being found.
    const hits = await source.search('hoe installeer ik de widget', 'nl', 3);
    expect(hits.every((h) => h.locale === 'nl')).toBe(true);
  });
});
