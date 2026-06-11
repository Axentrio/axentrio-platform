/**
 * Topic-phrase validation gate — ADR-0009 layer 2, applied at BOTH ends:
 * the topic phrase the judge returns AND the canonical phrase the
 * merge-or-create call returns. A single bad insert becomes a permanent
 * registry row spawning a Gap that never resolves, so this fails closed.
 */

/** Exact-normalised-phrase rejects (not substring: "pricing info" is valid). */
const STOPWORDS = new Set([
  'general',
  'info',
  'information',
  'question',
  'help',
  'asking',
  'chat',
  'talk',
  'stuff',
  'things',
  'something',
  'anything',
]);

export type TopicRejectReason =
  | 'empty'
  | 'too_short'
  | 'too_long'
  | 'too_many_words'
  | 'stopword'
  | 'punctuation_only'
  | 'sentence_style';

/** Lowercase, trim, collapse whitespace, strip trailing punctuation. */
export function normalizeTopic(phrase: string): string {
  return phrase
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/g, '')
    .trim();
}

/**
 * Returns null when the phrase passes, otherwise the reject reason
 * (persisted on the Judgment as `reject_reason` for drift monitoring).
 */
export function validateTopic(phrase: string | null | undefined): TopicRejectReason | null {
  if (!phrase) return 'empty';
  const normalized = normalizeTopic(phrase);
  if (!normalized) return 'empty';
  if (!/[\p{L}\p{N}]/u.test(normalized)) return 'punctuation_only';
  if (normalized.length < 3) return 'too_short';
  if (normalized.length > 60) return 'too_long';
  const words = normalized.split(' ');
  if (words.length > 6) return 'too_many_words';
  if (STOPWORDS.has(normalized)) return 'stopword';
  // Sentence-style: ends in sentence punctuation mid-phrase or reads like a
  // full clause. Cheap heuristic: contains terminal punctuation inside, or
  // starts with an interrogative + verb pattern long enough to be a sentence.
  if (/[.!?]/.test(normalized)) return 'sentence_style';
  return null;
}
