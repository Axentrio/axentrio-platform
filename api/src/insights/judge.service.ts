/**
 * LLM judge — one verdict per ChatSession (ADR-0004).
 *
 * Closed sessions get a full judgement; handoff sessions are auto-flagged
 * unsatisfied (the customer needed a human — definitionally not satisfied by
 * the bot) but still pass through the LLM for topic extraction + evidence.
 * Topic phrases come back in English regardless of customer language
 * (ADR-0010) and are validated per ADR-0009 before any registry contact.
 */
import { getProvider } from '../llm/provider-factory';
import { DEFAULT_MODEL } from '../llm/defaults';
import { logger } from '../utils/logger';

export interface TranscriptMessage {
  id: string;
  sender: 'user' | 'agent' | 'bot' | 'system';
  content: string;
}

/** Mutable token tally the refresh job threads through all insight LLM calls. */
export interface UsageTally {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface JudgeVerdict {
  hadQuestion: boolean;
  satisfied: boolean | null;
  /** English topic phrase, or null when no specific topic is extractable. */
  topicPhrase: string | null;
  evidenceMessageIds: string[];
  reasoning: string | null;
  /**
   * Basic sentiment — populated when judged with `withSentiment`.
   * null/undefined otherwise.
   */
  sentiment: 'positive' | 'negative' | 'neutral' | null;
  /** Short English praise/complaint theme phrase, or null. */
  sentimentTheme: string | null;
}

const SYSTEM_PROMPT = `You judge one customer-support chat transcript for a small business.

Answer ONLY with a JSON object: {"hadQuestion": boolean, "satisfied": boolean|null, "topic": string|null, "evidenceMessageIds": string[], "reasoning": string}

Rules:
- hadQuestion: did the customer ask the business something (a question, request, or need)? Small talk alone = false.
- satisfied: was the customer's need actually answered/handled by the assistant? null when hadQuestion is false. Judge the substance — a polite deflection or "I don't know" is NOT satisfied.
- topic: a short English topic phrase (1-6 words, e.g. "pricing", "emergency availability") naming what the customer asked about — in English regardless of the customer's language. If the question is unclear, generic, or you cannot extract a specific topic, return null.
- evidenceMessageIds: the ids of the 1-4 messages that best support your verdict (the ask, and the answer or non-answer).
- reasoning: one or two sentences, plain language, citing what the customer asked and how the assistant responded.`;

/**
 * Basic sentiment extension. Themes are intentionally absent so Essential and
 * Pro judgments cannot feed the Enterprise-only theme registry.
 */
const BASIC_SENTIMENT_PROMPT = `${SYSTEM_PROMPT.replace(
  '{"hadQuestion": boolean, "satisfied": boolean|null, "topic": string|null, "evidenceMessageIds": string[], "reasoning": string}',
  '{"hadQuestion": boolean, "satisfied": boolean|null, "topic": string|null, "evidenceMessageIds": string[], "reasoning": string, "sentiment": "positive"|"negative"|"neutral"}',
)}
- sentiment: the customer's overall sentiment in this chat — "positive", "negative", or "neutral".`;

/** Enterprise extension: basic sentiment plus a canonicalisable theme phrase. */
const SENTIMENT_THEME_PROMPT = `${SYSTEM_PROMPT.replace(
  '{"hadQuestion": boolean, "satisfied": boolean|null, "topic": string|null, "evidenceMessageIds": string[], "reasoning": string}',
  '{"hadQuestion": boolean, "satisfied": boolean|null, "topic": string|null, "evidenceMessageIds": string[], "reasoning": string, "sentiment": "positive"|"negative"|"neutral", "sentimentTheme": string|null}',
)}
- sentiment: the customer's overall sentiment in this chat — "positive", "negative", or "neutral".
- sentimentTheme: if the customer expressed a SPECIFIC recurring praise or complaint (e.g. "slow response", "friendly staff", "confusing pricing"), a short English theme phrase (1-5 words). If there is no specific praise/complaint, return null. Generic mood with no theme = null.`;

/** Cap transcript size sent to the judge — long sessions are truncated head+tail. */
const MAX_MESSAGES = 60;

function renderTranscript(messages: TranscriptMessage[]): string {
  let window = messages;
  if (messages.length > MAX_MESSAGES) {
    const head = messages.slice(0, MAX_MESSAGES / 2);
    const tail = messages.slice(-MAX_MESSAGES / 2);
    window = [...head, { id: '-', sender: 'system', content: '[…transcript truncated…]' }, ...tail];
  }
  return window
    .map((m) => `[${m.id}] ${m.sender === 'user' ? 'CUSTOMER' : m.sender.toUpperCase()}: ${m.content}`)
    .join('\n');
}

interface JudgeOptions {
  withSentiment?: boolean;
  withSentimentThemes?: boolean;
}

function selectSystemPrompt(opts?: JudgeOptions): string {
  if (opts?.withSentimentThemes) return SENTIMENT_THEME_PROMPT;
  if (opts?.withSentiment) return BASIC_SENTIMENT_PROMPT;
  return SYSTEM_PROMPT;
}

function parseJudgeResponse(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content);
  } catch {
    logger.warn('[insights-judge] unparseable judge response', {
      snippet: content.slice(0, 200),
    });
    throw new Error('Judge returned unparseable JSON');
  }
}

/** Evidence ids are only trusted when they name a message we actually sent. */
function extractEvidenceIds(
  parsed: Record<string, unknown>,
  messages: TranscriptMessage[],
): string[] {
  if (!Array.isArray(parsed.evidenceMessageIds)) return [];
  const knownIds = new Set(messages.map((m) => m.id));
  return (parsed.evidenceMessageIds as unknown[]).filter(
    (id): id is string => typeof id === 'string' && knownIds.has(id),
  );
}

function extractSentiment(
  parsed: Record<string, unknown>,
  opts?: JudgeOptions,
): 'positive' | 'negative' | 'neutral' | null {
  if (!opts?.withSentiment && !opts?.withSentimentThemes) return null;
  if (!['positive', 'negative', 'neutral'].includes(parsed.sentiment as string)) return null;
  return parsed.sentiment as 'positive' | 'negative' | 'neutral';
}

function extractSentimentTheme(
  parsed: Record<string, unknown>,
  opts?: JudgeOptions,
): string | null {
  if (!opts?.withSentimentThemes) return null;
  if (typeof parsed.sentimentTheme !== 'string' || !parsed.sentimentTheme.trim()) return null;
  return parsed.sentimentTheme;
}

/**
 * Judge one session transcript. `isHandoff` forces satisfied=false per
 * ADR-0004 ("automatic flag for status='handoff'") regardless of the LLM's
 * satisfaction read — but topic + evidence still come from the LLM.
 * Throws on LLM/parse failure; the caller decides whether the session stays
 * pending (it does — the watermark only advances past judged sessions).
 */
export async function judgeTranscript(
  tenantId: string,
  messages: TranscriptMessage[],
  isHandoff: boolean,
  tally?: UsageTally,
  opts?: { withSentiment?: boolean; withSentimentThemes?: boolean },
): Promise<JudgeVerdict> {
  // tenantId is for spend attribution only. The nightly judge must not consume
  // the tenant's dailyLlmCalls quota, which protects their live bot.
  const provider = getProvider({ path: 'insights_judge', tenantId });
  const response = await provider.chat(
    [
      { role: 'system', content: selectSystemPrompt(opts) },
      { role: 'user', content: renderTranscript(messages) },
    ],
    {
      model: DEFAULT_MODEL,
      maxTokens: 500,
      temperature: 0,
      jsonMode: true,
      reasoningEffort: 'low',
    },
  );

  if (tally) {
    tally.promptTokens += response.usage.promptTokens;
    tally.completionTokens += response.usage.completionTokens;
    tally.calls += 1;
  }

  const parsed = parseJudgeResponse(response.content);

  const hadQuestion = parsed.hadQuestion === true;
  let satisfied: boolean | null = hadQuestion ? parsed.satisfied === true : null;
  if (isHandoff && hadQuestion) satisfied = false;

  return {
    hadQuestion,
    satisfied,
    topicPhrase: typeof parsed.topic === 'string' && parsed.topic.trim() ? parsed.topic : null,
    evidenceMessageIds: extractEvidenceIds(parsed, messages),
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 1000) : null,
    sentiment: extractSentiment(parsed, opts),
    sentimentTheme: extractSentimentTheme(parsed, opts),
  };
}
