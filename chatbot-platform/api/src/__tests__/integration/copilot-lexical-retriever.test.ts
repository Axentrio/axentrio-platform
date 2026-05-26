/**
 * Integration: LexicalCopilotKnowledgeSource against a real pg_trgm-backed DB.
 *
 * Covers PR3 deliverable:
 *   - Top-N ranking by word_similarity
 *   - Locale filter (rows in the wrong locale never returned)
 *   - Locale fallback (nl with no rows → en results returned, locale field reflects en)
 *   - Excerpt window (~240 chars, centered on matched term, ellipsis-padded)
 *   - Min-score threshold (low-relevance rows dropped)
 *   - Empty query / empty corpus / over-large limit edge cases
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { LexicalCopilotKnowledgeSource, extractExcerpt } from '../../copilot/knowledge/lexical';

async function seedDoc(slug: string, locale: 'en' | 'nl' | 'fr', title: string, body: string, tags: string[] = []) {
  await AppDataSource.query(
    `INSERT INTO chatbot_copilot_docs (slug, locale, title, body, tags, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [slug, locale, title, body, tags, 'test-hash-' + slug + '-' + locale],
  );
}

describe('LexicalCopilotKnowledgeSource', () => {
  beforeEach(async () => {
    await seedDoc(
      'connecting-calcom',
      'en',
      'Connecting Cal.com for bookings',
      'Cal.com integration lets your bot book meetings into your calendar. Open Bookings → Integrations and click Connect Cal.com to authorize. Tier: Pro and Enterprise only — Essential admins see a Pro lock.',
      ['integrations', 'calcom'],
    );
    await seedDoc(
      'installing-the-widget',
      'en',
      'Installing the chat widget',
      'The widget is a small JavaScript snippet you paste once into your website HTML. Get the snippet at AI Bot and Content → Embed. Paste it before the closing body tag.',
      ['widget', 'install'],
    );
    await seedDoc(
      'cancelling-your-subscription',
      'en',
      'How to cancel your subscription',
      'Open Settings → Billing → Cancel subscription. Your tenant remains active until the end of the billing period. After period end, the bot is paused and the widget stops responding.',
      ['billing', 'cancellation'],
    );
    await seedDoc(
      'plan-pro',
      'en',
      "What's included in the Pro plan",
      'Pro adds Cal.com bookings, widget branding, the AI Platform Assistant, higher daily limits, and priority support.',
      ['plans', 'pro'],
    );
    // One French row whose content is wildly different, to verify the
    // locale filter — a query like 'cal.com' must NOT match this row
    // when the requested locale is 'en'.
    await seedDoc(
      'plan-pro-fr',
      'fr',
      'Forfait Pro',
      'Le forfait Pro ajoute les réservations Cal.com et le branding du widget.',
      ['plans'],
    );
  });

  describe('ranking + locale filter', () => {
    it('ranks the most relevant English doc first', async () => {
      const r = new LexicalCopilotKnowledgeSource(AppDataSource.manager);
      const hits = await r.search('how do I connect calcom', 'en', 3);

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].slug).toBe('connecting-calcom');
      expect(hits[0].locale).toBe('en');
      expect(hits[0].rank).toBe(0);
      expect(hits[0].retrievalType).toBe('lexical');
      expect(hits[0].score).toBeGreaterThan(0.15);
      // The French row must not appear in English-locale results.
      expect(hits.find((h) => h.slug === 'plan-pro-fr')).toBeUndefined();
    });

    it('respects the limit', async () => {
      const r = new LexicalCopilotKnowledgeSource(AppDataSource.manager);
      const hits = await r.search('plan billing widget calcom subscription', 'en', 2);
      expect(hits.length).toBeLessThanOrEqual(2);
    });

    it('ranks ties stably and emits monotonic ranks', async () => {
      const r = new LexicalCopilotKnowledgeSource(AppDataSource.manager);
      const hits = await r.search('widget', 'en', 5);
      expect(hits.length).toBeGreaterThan(0);
      for (let i = 0; i < hits.length; i++) {
        expect(hits[i].rank).toBe(i);
      }
    });
  });

  describe('locale fallback', () => {
    it('falls back to en when the requested locale has zero rows', async () => {
      const r = new LexicalCopilotKnowledgeSource(AppDataSource.manager);
      // 'nl' has zero rows in the fixture set, so 'nl' should fall back to 'en'.
      const hits = await r.search('how do I connect calcom', 'nl', 3);

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].slug).toBe('connecting-calcom');
      // The returned locale must reflect the locale actually served (en),
      // so the prompt template can flag the language drift.
      expect(hits[0].locale).toBe('en');
    });

    it('does not fall back when the requested locale itself returned hits', async () => {
      const r = new LexicalCopilotKnowledgeSource(AppDataSource.manager);
      // 'fr' has one row whose body contains 'Cal.com' — fr should serve it,
      // NOT fall back to en.
      const hits = await r.search('forfait Pro Cal.com', 'fr', 3);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.locale === 'fr')).toBe(true);
    });
  });

  describe('excerpt window', () => {
    it('produces an excerpt within ~window size + ellipsis padding', async () => {
      const r = new LexicalCopilotKnowledgeSource(AppDataSource.manager);
      const hits = await r.search('cancel subscription', 'en', 1);
      expect(hits[0].slug).toBe('cancelling-your-subscription');
      // 240-char window + at most 2 ellipsis chars + small word-boundary slack
      expect(hits[0].excerpt.length).toBeLessThanOrEqual(260);
      expect(hits[0].excerpt.toLowerCase()).toContain('cancel');
    });
  });

  describe('edge cases', () => {
    it('returns [] for empty query', async () => {
      const r = new LexicalCopilotKnowledgeSource(AppDataSource.manager);
      expect(await r.search('', 'en', 5)).toEqual([]);
      expect(await r.search('    ', 'en', 5)).toEqual([]);
    });

    it('returns [] for limit < 1', async () => {
      const r = new LexicalCopilotKnowledgeSource(AppDataSource.manager);
      expect(await r.search('widget', 'en', 0)).toEqual([]);
    });

    it('returns [] when neither requested locale nor en fallback has matches', async () => {
      // Truncate the corpus inside this test so the en fallback has nothing.
      await AppDataSource.query(`DELETE FROM chatbot_copilot_docs`);
      const r = new LexicalCopilotKnowledgeSource(AppDataSource.manager);
      expect(await r.search('widget', 'nl', 5)).toEqual([]);
    });

    it('filters out low-relevance rows below the min-score threshold', async () => {
      const r = new LexicalCopilotKnowledgeSource(AppDataSource.manager);
      // Total nonsense query — pg_trgm should score everything < 0.15.
      const hits = await r.search('xqzbf wjkmt vplnr', 'en', 5);
      expect(hits).toEqual([]);
    });
  });
});

describe('extractExcerpt', () => {
  it('returns body prefix when no query word matches', () => {
    const body = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' + 'X'.repeat(300);
    const out = extractExcerpt(body, 'xqzbf', 240);
    expect(out.length).toBeLessThanOrEqual(241);
    expect(out.startsWith('Lorem')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('centers window around the first matched query word', () => {
    const body =
      'A '.repeat(100) +
      'INSTALLATION INSTRUCTIONS for the widget begin here in the middle. ' +
      'B '.repeat(100);
    const out = extractExcerpt(body, 'installation', 100);
    expect(out.toLowerCase()).toContain('installation');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not add leading ellipsis when window starts at body start', () => {
    const body = 'Install the widget by pasting the snippet. ' + 'Z '.repeat(300);
    const out = extractExcerpt(body, 'install', 100);
    expect(out.startsWith('Install')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not add trailing ellipsis when window covers the end', () => {
    const body = 'Z '.repeat(300) + 'finally we install the widget here.';
    const out = extractExcerpt(body, 'install', 100);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('here.')).toBe(true);
  });

  it('skips stopwords when picking the centering word', () => {
    const body =
      'The ' + 'A '.repeat(80) + 'install the widget at the end of this body.';
    const out = extractExcerpt(body, 'the install', 60);
    // Must center on `install`, not on the very-first 'The' (a stopword).
    expect(out.toLowerCase()).toContain('install');
  });
});
