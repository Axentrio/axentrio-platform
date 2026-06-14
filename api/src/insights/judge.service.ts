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
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../llm/defaults';
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
   * Sentiment (P3 / ADR-0014, D5) — only populated when judged with
   * `withSentiment` (Enterprise tenants). null/undefined otherwise.
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
 * Enterprise-only extension (D5). Appended to the base prompt + JSON shape ONLY
 * when `withSentiment` is set — non-Enterprise judging stays byte-identical to
 * SYSTEM_PROMPT above, so sentiment is purely additive and entitled-only.
 */
const SENTIMENT_PROMPT = `${SYSTEM_PROMPT.replace(
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

/**
 * Judge one session transcript. `isHandoff` forces satisfied=false per
 * ADR-0004 ("automatic flag for status='handoff'") regardless of the LLM's
 * satisfaction read — but topic + evidence still come from the LLM.
 * Throws on LLM/parse failure; the caller decides whether the session stays
 * pending (it does — the watermark only advances past judged sessions).
 */
export async function judgeTranscript(
  messages: TranscriptMessage[],
  isHandoff: boolean,
  tally?: UsageTally,
  opts?: { withSentiment?: boolean },
): Promise<JudgeVerdict> {
  // Deliberately NOT passing tenantId to getProvider: the nightly judge is
  // platform-side batch work and must not consume the tenant's dailyLlmCalls
  // quota (which protects their live bot). Cost is tracked via the tally
  // (ADR-0006: "monitor token spend via billing telemetry").
  const provider = getProvider(DEFAULT_PROVIDER);
  const response = await provider.chat(
    [
      { role: 'system', content: opts?.withSentiment ? SENTIMENT_PROMPT : SYSTEM_PROMPT },
      { role: 'user', content: renderTranscript(messages) },
    ],
    { model: DEFAULT_MODEL, maxTokens: 500, temperature: 0, jsonMode: true },
  );

  if (tally) {
    tally.promptTokens += response.usage.promptTokens;
    tally.completionTokens += response.usage.completionTokens;
    tally.calls += 1;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    logger.warn('[insights-judge] unparseable judge response', {
      snippet: response.content.slice(0, 200),
    });
    throw new Error('Judge returned unparseable JSON');
  }

  const knownIds = new Set(messages.map((m) => m.id));
  const evidence = Array.isArray(parsed.evidenceMessageIds)
    ? (parsed.evidenceMessageIds as unknown[]).filter(
        (id): id is string => typeof id === 'string' && knownIds.has(id),
      )
    : [];

  const hadQuestion = parsed.hadQuestion === true;
  let satisfied: boolean | null = hadQuestion ? parsed.satisfied === true : null;
  if (isHandoff && hadQuestion) satisfied = false;

  const sentiment =
    opts?.withSentiment && ['positive', 'negative', 'neutral'].includes(parsed.sentiment as string)
      ? (parsed.sentiment as 'positive' | 'negative' | 'neutral')
      : null;
  const sentimentTheme =
    opts?.withSentiment && typeof parsed.sentimentTheme === 'string' && parsed.sentimentTheme.trim()
      ? parsed.sentimentTheme
      : null;

  return {
    hadQuestion,
    satisfied,
    topicPhrase: typeof parsed.topic === 'string' && parsed.topic.trim() ? parsed.topic : null,
    evidenceMessageIds: evidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 1000) : null,
    sentiment,
    sentimentTheme,
  };
}
