/**
 * Offline proactive-ask eval — `npm run eval:proactive`.
 *
 * Makes REAL model calls against the committed fixtures and scores them against
 * published thresholds, so "the bot asks for contact details without ever feeling
 * pushy" is a measurement anyone can re-run rather than a claim. Requires OPENAI_API_KEY.
 *
 * The approved plan made this harness a HARD PRECONDITION for shipping a prompt-level
 * ask: the previous attempt was validated by a harness that was never committed, so its
 * result could not be defended or re-run against a new model. Re-run this and update the
 * numbers whenever PROACTIVE_ASK_RULE changes or the platform model is bumped.
 *
 * Scoring asymmetry is deliberate:
 *   - ask-rate has a threshold (a missed offer is a lost lead, a business cost)
 *   - unwanted asks have a ceiling of ZERO (each is the forced questionnaire the spec
 *     forbids: soliciting an EU consumer's personal data when we promised we would not)
 *
 * NOTE: `api/.env` points at PRODUCTION. This script only reads an LLM key and touches
 * no database, but run it with an explicit env if in doubt.
 */
import { getProvider } from '../../../llm/provider-factory';
import { DEFAULT_MODEL } from '../../../llm/defaults';
import { PROACTIVE_ASK_RULE } from '../should-ask';
import {
  PROACTIVE_EVAL_CASES,
  PROACTIVE_EVAL_THRESHOLDS,
  type ProactiveEvalCase,
} from './fixtures';

/**
 * A minimal stand-in for the real composed prompt. Deliberately NOT the full
 * composeSystemPrompt output: this eval measures ONE block's effect on wording, and
 * dragging in template bodies, KB context and platform rules would make a regression
 * here indistinguishable from a change anywhere else in the prompt.
 */
const BASE_PROMPT =
  'You are the assistant for De Vries Loodgieters, a Belgian plumbing business. ' +
  'Answer customer questions helpfully and concisely in the language the customer writes in. ' +
  'You have no booking tool available in this conversation.';

/** Contact-detail nouns across the three languages the platform serves. */
const CONTACT_NOUN =
  /\b(e-?mail(adres)?|mail(adres)?|courriel|phone|telephone|téléphone|telefoon(nummer)?|gsm|mobile|nummer|numéro|number|contact details|contactgegevens|coordonnées)\b/i;

/**
 * Cues that a sentence is REQUESTING contact details rather than mentioning them.
 *
 * Includes the INVITATION forms, not just interrogatives. The first run of this eval
 * scored a false negative on "Je kunt een e-mailadres of telefoonnummer achterlaten"
 * — a perfectly good ask, phrased as an offer with no question mark and no modal the
 * original pattern list covered. A detector that only recognises questions would have
 * let the ask-rate metric drift downward while the bot behaved correctly, and the
 * printed-verbatim failure output is what exposed it.
 */
const REQUEST_CUE =
  /(\?|\bmay i\b|\bcould you\b|\bcan i\b|\bwould you like\b|\bfeel free to\b|\bleave\b|\bshare\b|\bprovide\b|\blet me know\b|\bmag ik\b|\bkunt u\b|\bkun je\b|\bje kunt\b|\bu kunt\b|\bzou u\b|\bachter ?(te )?laten\b|\bachterlaten\b|\bdoorgeven\b|\bdelen\b|\blaat (het )?(me|ons)\b|\bgeef\b|\bpuis-je\b|\bpouvez-vous\b|\bsouhaitez-vous\b|\bvoulez-vous\b|\blaissez\b|\blaisser\b|\bpartager\b|\bcommuniquer\b)/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Did the reply request contact details? A sentence must contain BOTH a contact noun
 * and a request cue — "I'll pass this to the team who will call you back" mentions a
 * call without asking for a number, and must not count as an ask.
 *
 * A heuristic, and knowingly imperfect in the FALSE-NEGATIVE direction (an exotic
 * phrasing could slip past). That bias is the safe one for a ceiling-of-zero metric
 * only insofar as it under-reports violations, so the fixtures deliberately use plain
 * phrasings the detector reliably catches, and every violation is printed verbatim for
 * a human to confirm.
 */
export function asksForContact(reply: string): boolean {
  return sentences(reply).some((s) => CONTACT_NOUN.test(s) && REQUEST_CUE.test(s));
}

/**
 * Did the reply actually SERVE the customer, or was it only an ask? At least one
 * substantive sentence that is not the contact request. An offer that replaces the
 * answer is the questionnaire failure even when the wording is polite.
 */
export function answersSubstantively(reply: string): boolean {
  return sentences(reply).some((s) => !CONTACT_NOUN.test(s) && s.length > 20);
}

interface CaseResult {
  name: string;
  language: string;
  asked: boolean;
  answered: boolean;
  wantedAsk: boolean;
  unwantedAsk: boolean;
  missedAsk: boolean;
  coercive: string[];
  reply: string;
}

async function runCase(c: ProactiveEvalCase): Promise<CaseResult> {
  const provider = getProvider({ path: 'lead_extract' });
  const system = c.askEnabled ? BASE_PROMPT + PROACTIVE_ASK_RULE : BASE_PROMPT;
  const response = await provider.chat(
    [
      { role: 'system', content: system },
      // Prior turns are replayed as user messages only; the assistant's own earlier
      // wording is not part of what we are measuring, and inventing it would put words
      // in the model's mouth that could themselves carry an ask.
      ...c.messages.map((m) => ({ role: 'user' as const, content: m })),
    ],
    // jsonMode false: we are measuring PROSE, which is the whole point.
    { model: DEFAULT_MODEL, maxTokens: 400, temperature: 0, jsonMode: false },
  );
  const reply = response.content ?? '';

  const asked = asksForContact(reply);
  const answered = answersSubstantively(reply);
  const coercive = (c.expect.mustNotContain ?? []).filter((n) =>
    reply.toLowerCase().includes(n.toLowerCase()),
  );

  return {
    name: c.name,
    language: c.language,
    asked,
    answered,
    wantedAsk: c.expect.asks === true,
    unwantedAsk: c.expect.mustNotAsk === true && asked,
    missedAsk: c.expect.asks === true && !asked,
    coercive,
    reply,
  };
}

async function main(): Promise<void> {
  const results: CaseResult[] = [];
  for (const c of PROACTIVE_EVAL_CASES) results.push(await runCase(c));

  const wanted = results.filter((r) => r.wantedAsk);
  const askHits = wanted.filter((r) => r.asked).length;
  const askRate = wanted.length ? askHits / wanted.length : 1;

  const unwanted = results.filter((r) => r.unwantedAsk);
  // "Answered" only has to hold where the fixture asked for it; a case with no
  // mustAnswer expectation is not penalised for a terse reply.
  const unanswered = results.filter(
    (r) => PROACTIVE_EVAL_CASES.find((c) => c.name === r.name)?.expect.mustAnswer && !r.answered,
  );
  const coercive = results.filter((r) => r.coercive.length > 0);
  const unansweredOrCoercive = new Set([...unanswered, ...coercive]).size;

  const pass =
    askRate >= PROACTIVE_EVAL_THRESHOLDS.minAskRate &&
    unwanted.length <= PROACTIVE_EVAL_THRESHOLDS.maxUnwantedAsks &&
    unansweredOrCoercive <= PROACTIVE_EVAL_THRESHOLDS.maxUnansweredOrCoercive;

  const summary = [
    `cases:                  ${results.length}`,
    `ask rate:               ${askHits}/${wanted.length} (${(askRate * 100).toFixed(1)}%)  threshold ≥${(PROACTIVE_EVAL_THRESHOLDS.minAskRate * 100).toFixed(0)}%`,
    `unwanted asks:          ${unwanted.length}  threshold ≤${PROACTIVE_EVAL_THRESHOLDS.maxUnwantedAsks}`,
    `unanswered or coercive: ${unansweredOrCoercive}  threshold ≤${PROACTIVE_EVAL_THRESHOLDS.maxUnansweredOrCoercive}`,
  ].join('\n');

  const detail = results
    .filter((r) => r.unwantedAsk || r.missedAsk || r.coercive.length || (r.wantedAsk && !r.answered))
    .map((r) => {
      const why = [
        r.unwantedAsk ? 'ASKED WHEN IT MUST NOT' : '',
        r.missedAsk ? 'missed the offer' : '',
        r.coercive.length ? `coercive: ${r.coercive.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' | ');
      // Print the reply IN FULL: a ceiling-of-zero metric must be auditable by a human,
      // not taken on the regex's word, and a truncated reply hides the very sentence
      // being judged.
      return `  ✗ [${r.language}] ${r.name}\n      ${why}\n      reply: ${r.reply.replace(/\n/g, ' ')}`;
    })
    .join('\n');

  // eslint-disable-next-line no-console
  console.log(
    `\n=== proactive contact-ask eval ===\n${summary}\n${detail ? `\n${detail}\n` : ''}\n${pass ? 'PASS' : 'FAIL'}\n`,
  );
  process.exit(pass ? 0 : 1);
}

if (require.main === module) {
  void main();
}
