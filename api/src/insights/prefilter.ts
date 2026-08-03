/**
 * Layer 1 — the cheap pass that decides whether a conversation is worth the expensive one.
 *
 * Every eligible session currently costs one LLM call, and on production 6.9% of them
 * contain NO customer message at all: someone opened the widget and left. The judge is
 * being paid to report that silence contained no question. Another 48% hold exactly one
 * customer line, some of which are real questions and some of which are "hi".
 *
 * So this decides one thing only: can this conversation possibly yield a topic? When it
 * cannot, the verdict is knowable without a model — `hadQuestion: false`, no topic, no
 * evidence — which is byte-identical to what the judge returns for the same input, at
 * zero cost.
 *
 * CONSERVATIVE BY CONSTRUCTION. A wrong skip loses a real customer question forever: it
 * never becomes a Gap, and nothing downstream will ever revisit it. A wrong *keep* costs
 * a fraction of a cent. The rules below therefore only fire on conversations where there
 * is demonstrably nothing to extract, and anything ambiguous goes to the judge. If you
 * are tempted to add a cleverer rule here, the bar is: could a plumber's actual customer
 * have written this? If yes, it is not noise.
 *
 * SKIPPED SESSIONS ARE STILL JUDGED, JUST NOT BY A MODEL. The caller persists a real
 * Judgment row for them, so `judgments_completeness` — judged / eligible — is untouched.
 * Dropping them instead would have driven completeness toward 0.45 on this data and made
 * the UI announce "Insights incomplete", which is the opposite of the intent.
 */

/** Mirrors judge.service's TranscriptMessage; kept structural to avoid a circular import. */
export interface PrefilterMessage {
  sender: 'user' | 'agent' | 'bot' | 'system';
  content: string;
}

export type SkipReason = 'no_customer_text' | 'greeting_only';

export type PrefilterDecision =
  | { judge: true }
  | { judge: false; reason: SkipReason; note: string };

/**
 * Pure pleasantries in the three languages the platform serves. Deliberately tiny: every
 * entry is a phrase that cannot, on its own, express a need. "thanks" is here; "help" is
 * not, and neither is anything naming a service, a time or a problem.
 */
const PLEASANTRIES = new Set([
  // en
  'hi', 'hii', 'hey', 'hello', 'yo', 'good morning', 'good afternoon', 'good evening',
  'thanks', 'thank you', 'thx', 'ty', 'ok', 'okay', 'k', 'cool', 'great', 'nice',
  'bye', 'goodbye', 'see you', 'cheers', 'test', 'testing', 'yes', 'no', 'yep', 'nope',
  // nl
  'hoi', 'hallo', 'hey daar', 'goedemorgen', 'goedemiddag', 'goedenavond', 'dag',
  'bedankt', 'dank je', 'dank u', 'dankjewel', 'oke', 'oké', 'prima', 'top',
  'doei', 'tot ziens', 'ja', 'nee', 'test bericht',
  // fr
  'salut', 'bonjour', 'bonsoir', 'coucou', 'merci', 'merci beaucoup', 'd accord',
  'daccord', 'ok merci', 'au revoir', 'bonne journée', 'oui', 'non', 'essai',
]);

/**
 * Beyond this many characters of customer text we stop guessing and pay for the judge.
 * Someone who typed forty characters was telling us something, whatever words they used.
 */
const NOISE_CHAR_LIMIT = 40;

/** Lowercase, strip punctuation and collapse whitespace, so "Hallo!!" matches "hallo". */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A question mark is the strongest cheap signal there is, and it survives every language
 * this platform serves. Its presence alone sends the conversation to the judge.
 */
function looksLikeAQuestion(raw: string): boolean {
  return raw.includes('?') || raw.includes('？');
}

export function prefilterTranscript(messages: PrefilterMessage[]): PrefilterDecision {
  const customer = messages.filter((m) => m.sender === 'user' && m.content.trim().length > 0);

  if (customer.length === 0) {
    return {
      judge: false,
      reason: 'no_customer_text',
      note: 'Layer 1: the visitor never wrote anything, so there is no question to judge.',
    };
  }

  const raw = customer.map((m) => m.content).join(' ');
  if (looksLikeAQuestion(raw)) return { judge: true };

  const normalisedTotal = normalise(raw);
  if (normalisedTotal.length > NOISE_CHAR_LIMIT) return { judge: true };

  // Every message has to be a pleasantry. One line of substance among three "hi"s is
  // still a conversation with something in it.
  const allPleasantries = customer.every((m) => PLEASANTRIES.has(normalise(m.content)));
  if (!allPleasantries) return { judge: true };

  return {
    judge: false,
    reason: 'greeting_only',
    note: `Layer 1: the visitor only exchanged greetings (${normalisedTotal.length} chars), so there is no topic to extract.`,
  };
}

/** Per-run counters, logged so the saving is measurable instead of asserted. */
export interface PrefilterTally {
  judged: number;
  skipped: number;
  byReason: Record<SkipReason, number>;
}

export function emptyPrefilterTally(): PrefilterTally {
  return { judged: 0, skipped: 0, byReason: { no_customer_text: 0, greeting_only: 0 } };
}
