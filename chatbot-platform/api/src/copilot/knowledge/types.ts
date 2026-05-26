/**
 * Retrieval interface for the Copilot's FAQ-grounded knowledge source.
 *
 * v1 has one implementation (`LexicalCopilotKnowledgeSource`, pg_trgm
 * word similarity over `chatbot_copilot_docs`). v2 will add a vector
 * implementation; v3 may add a hybrid merger. All implementations
 * conform to `CopilotKnowledgeSource.search(...)` so the agent loop
 * never knows which is active — selection happens in
 * `knowledge/factory.ts` from the `COPILOT_RETRIEVAL_MODE` env.
 *
 * `Snippet.locale` reflects the locale of the row that was ACTUALLY
 * served, not the locale the caller requested. v1 falls back to `en`
 * silently when the requested locale has no docs (per plan Q4 locale
 * fallback); the prompt template inspects `Snippet.locale` to flag
 * "answering in English; translation pending" when relevant.
 */
import type { CopilotLocale } from '../../database/entities/CopilotDoc';

export type Locale = CopilotLocale;

export type RetrievalType = 'lexical' | 'vector' | 'hybrid';

export interface Snippet {
  /** UUID of the source `chatbot_copilot_docs` row. */
  docId: string;
  slug: string;
  title: string;
  /** Locale of the served row — may differ from the requested locale (fallback). */
  locale: Locale;
  /** ≤ ~240 chars; window centered on the matched span, ellipsis-padded. */
  excerpt: string;
  /** Zero-based rank within this search call (0 = best). */
  rank: number;
  /** Score returned by the underlying retriever (lexical: word_similarity 0..1). */
  score: number;
  retrievalType: RetrievalType;
  /** `content_hash` of the served row; lets callers detect stale snippets across rebuilds. */
  contentHash: string;
}

export interface CopilotKnowledgeSource {
  /**
   * Return the top-`limit` snippets matching `query`, filtered by
   * `locale` with silent `en` fallback when the requested locale has
   * no docs.
   *
   * Implementations MUST:
   *   - Filter results by a minimum-relevance threshold (low-quality
   *     matches should not be returned at all)
   *   - Apply the locale fallback policy described above
   *   - Populate every field of `Snippet`
   */
  search(query: string, locale: Locale, limit: number): Promise<Snippet[]>;
}
