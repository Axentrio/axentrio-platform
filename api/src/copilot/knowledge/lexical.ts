/**
 * Lexical retriever using Postgres `pg_trgm.word_similarity`.
 *
 * `word_similarity(query, text)` finds the best contiguous trigram
 * window inside `text` that overlaps with `query` — exactly what we
 * want when matching a short admin question (~5-15 chars per word)
 * against a long doc body. Plain `similarity()` over the whole body
 * underweights short queries because the surrounding context dilutes
 * the trigram set; `word_similarity` does not.
 *
 * Locale fallback: requested locale first; if zero rows back, retry
 * with `en` (when the requested locale wasn't already `en`). Returned
 * `Snippet.locale` reflects the row actually served so the prompt
 * template can flag the language drift to the user.
 *
 * Excerpt window: 240 chars centered on the first matched query word
 * in the body, trimmed to word boundaries, ellipsis-padded.
 *
 * v1 scope:
 *   - One-shot ORDER BY scan per locale (no index-pre-filter). Fine
 *     while corpus < ~500 docs; v2 should add `set_limit()` +
 *     `query <% text` to use the GIN index when the corpus grows.
 *   - No query rewrite / stemming. The seed docs use plain admin
 *     vocabulary; nothing to gain from stemming at this size.
 */
import type { EntityManager } from 'typeorm';
import type { CopilotKnowledgeSource, Locale, Snippet } from './types';

const MIN_SCORE = 0.15;
const EXCERPT_WINDOW = 240;

interface DocRow {
  id: string;
  slug: string;
  title: string;
  body: string;
  locale: Locale;
  content_hash: string;
  score: string | number; // pg returns numeric as string in some drivers
}

export class LexicalCopilotKnowledgeSource implements CopilotKnowledgeSource {
  constructor(private readonly manager: EntityManager) {}

  async search(query: string, locale: Locale, limit: number): Promise<Snippet[]> {
    if (limit < 1) return [];
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    let hits = await this.querySimilar(trimmed, locale, limit);
    if (hits.length === 0 && locale !== 'en') {
      hits = await this.querySimilar(trimmed, 'en', limit);
    }
    return hits;
  }

  private async querySimilar(query: string, locale: Locale, limit: number): Promise<Snippet[]> {
    const rows: DocRow[] = await this.manager.query(
      `
      SELECT id, slug, title, body, locale, content_hash,
             word_similarity($1, title || ' ' || body) AS score
        FROM chatbot_copilot_docs
       WHERE locale = $2
       ORDER BY score DESC
       LIMIT $3
      `,
      [query, locale, limit],
    );

    const snippets: Snippet[] = [];
    let rank = 0;
    for (const r of rows) {
      const score = typeof r.score === 'string' ? parseFloat(r.score) : r.score;
      if (!Number.isFinite(score) || score < MIN_SCORE) continue;
      snippets.push({
        docId: r.id,
        slug: r.slug,
        title: r.title,
        locale: r.locale,
        excerpt: extractExcerpt(r.body, query, EXCERPT_WINDOW),
        rank: rank++,
        score,
        retrievalType: 'lexical',
        contentHash: r.content_hash,
      });
    }
    return snippets;
  }
}

/**
 * Pick a ~`window`-char window of `body` centered on the first
 * occurrence of any meaningful query word, ellipsis-padded at the
 * edges. Falls back to `body.slice(0, window)` when no word matches.
 *
 * Words shorter than 3 chars and a small stoplist are excluded from
 * the "first match" search — "the install widget" should center on
 * "install" or "widget", not "the".
 */
export function extractExcerpt(body: string, query: string, windowSize: number): string {
  const queryWords = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  const bodyLower = body.toLowerCase();
  let bestIdx = -1;
  for (const w of queryWords) {
    const idx = bodyLower.indexOf(w);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
  }

  if (bestIdx === -1) {
    const truncated = body.slice(0, windowSize).trimEnd();
    return body.length > windowSize ? truncated + '…' : truncated;
  }

  const half = Math.floor(windowSize / 2);
  let start = Math.max(0, bestIdx - half);
  let end = Math.min(body.length, start + windowSize);
  // If we hit the end early, extend left.
  if (end - start < windowSize && start > 0) {
    start = Math.max(0, end - windowSize);
  }

  // Snap to word boundaries within ±30 chars so we don't slice mid-word.
  if (start > 0) {
    const snap = body.lastIndexOf(' ', start);
    if (snap !== -1 && start - snap <= 30) start = snap + 1;
  }
  if (end < body.length) {
    const snap = body.indexOf(' ', end);
    if (snap !== -1 && snap - end <= 30) end = snap;
  }

  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return prefix + body.slice(start, end).trim() + suffix;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
  'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new',
  'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put',
  'say', 'she', 'too', 'use', 'with', 'from', 'this', 'that', 'have', 'what',
  'when', 'where', 'which', 'while', 'will', 'your', 'into', 'than', 'them',
  'they', 'were', 'been', 'does', 'should', 'would', 'could',
]);
