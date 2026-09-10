/**
 * The live LLM eval suite for the booking test plan (§4 of
 * `docs/booking-test-plan-remaining-work.md`).
 *
 * ── Why this file is not a test ─────────────────────────────────────────────
 *
 * It is deliberately NOT named `*.test.ts`. `vitest.config.ts:35` collects
 * `src/__tests__/**\/*.test.ts` and nothing else, and there is no exclude glob, so
 * collection is include-only: this file cannot be picked up by vitest and therefore
 * cannot be picked up by CI. That is the point. Five of the plan's cases are
 * assertions about a MODEL'S JUDGEMENT, and a judgement costs money and varies run to
 * run. Putting them in CI would either spend on every push or, far worse, be quietly
 * scripted until the "eval" only proved that a mock obeys.
 *
 *   Run it:      cd api && npm run eval:booking-plan
 *   Review it:   cd api && npm run eval:booking-plan -- --dry-run
 *   Prove it:    cd api && npm run eval:booking-plan -- --dry-run-broken
 *   Ad hoc:      npx tsx src/__tests__/live/booking-eval.ts --dry-run
 *
 * ── Why these five cases need a model at all ────────────────────────────────
 *
 * For each one the behaviour IS the model's choice, and a scripted model always
 * obeys, so a deterministic test can pin the server gate or the prompt text but can
 * never prove the choice:
 *
 *   SYS-03  a Dutch-configured bot answers `hey` in Dutch.
 *           The rule is prompt text only (`config/bot-language.ts:42-52`); no server
 *           gate exists, so there is nothing deterministic to assert.
 *   SYS-04  the same bot may answer an explicitly English message in English.
 *           Same reason. SYS-03 and SYS-04 are graded as a PAIR on purpose: a bot
 *           wedged in one language passes exactly one of them, so either alone is
 *           satisfiable by a broken bot.
 *   BK-02   a price question does not trigger a booking write.
 *           The deterministic half (`integration/booking-plan-lifecycle.test.ts:208`)
 *           proves only that `check_availability` is side-effect-free.
 *   BK-08   the model stays in Auto-book and does not offer a manual request.
 *           The existing pins are prompt copy plus `REQUEST_BEFORE_CHECK`, not the
 *           model's choice between two tools it can both see.
 *   SRV-02  exactly one clarifying question. The ask COUNT is a conversational
 *           property; §2.8 explicitly forbids faking it deterministically.
 *
 * ── What is graded ──────────────────────────────────────────────────────────
 *
 * Tool calls and state, never wording. The production `AgentService.run` drives the
 * production `PromptBuilder` and the production booking tools against a real
 * Postgres, so the evidence is: the tool calls the model ASKED for, the tool calls
 * that EXECUTED, and the rows and calendar writes that resulted. The only case that
 * reads the prose at all is the language pair, and it reads it through a classifier
 * with a self-test (see `classifyLanguage`), never a string match.
 *
 * ── Why a green run means something ─────────────────────────────────────────
 *
 * Three guards, because a suite that goes green when nothing ran is worse than no
 * suite:
 *
 *  1. A case whose PRECONDITION did not hold reports SKIPPED, never PASS. If
 *     `create_booking` was never even offered to the model, "the model did not book"
 *     is vacuous, so BK-02 skips instead of passing.
 *  2. SKIPPED exits non-zero unless `--allow-skip` is passed.
 *  3. `--dry-run-broken` scripts the FORBIDDEN behaviour into the stub and requires
 *     every case to report FAIL. That is the "break it and watch it fail" proof the
 *     work order asks for, run as code rather than claimed in a comment.
 *
 * ── The proof, run rather than claimed ─────────────────────────────────────
 *
 * Each guard above was verified by breaking the behaviour, watching the run fail, and
 * restoring it. Observed, in order:
 *
 *  A. `--dry-run` fed the BROKEN scripts (script selection inverted):
 *     `PASS 0  FAIL 5  SKIPPED 0`, exit 1. Every grader rejects the forbidden
 *     behaviour, and a failure exits non-zero.
 *  B. `--dry-run-broken` fed the CORRECT scripts (the same inversion):
 *     `BROKEN-MODE FAILURE: ... SYS-03(PASS), SYS-04(PASS), BK-02(PASS), BK-08(PASS),
 *     SRV-02(PASS)`, exit 1. Broken mode cannot congratulate itself.
 *  C. SYS-03's scripted reply replaced with `OK.`: `SKIPPED`, reason
 *     "the classifier could not decide", exit 2 — and exit 0 with `--allow-skip`.
 *  D. `classifyLanguage` degraded to always answer `nl`: the self-test rejected 5 of
 *     its 8 fixtures and the run exited 3 without grading anything. This is the guard
 *     that stops SYS-03 passing for the wrong reason.
 *  E. Both row halves land real state: `--dry-run-broken` BK-02 reports
 *     `bookings=1 requests=0 calendar_creates=1 emails=1` and BK-08 reports
 *     `bookings=1 requests=1`. The write path, the calendar mirror and the email
 *     ledger are the production ones, not a fake that always answers yes.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 *
 * This script owns its own database (`<base>_eval_<pid>`), builds the schema with the
 * suite's own `prepareTestSchema`, and drops it on the way out. It never touches the
 * vitest template or the per-worker databases. Every case seeds its OWN tenant, so no
 * TRUNCATE is needed between cases — but `PLAN_CALENDAR` is module state, not a row,
 * so it is reset per case exactly as the vitest convention requires.
 */

/* eslint-disable no-console */

import crypto from 'crypto';
import path from 'path';
import dotenv from 'dotenv';
import { DataSource } from 'typeorm';

// Type-only, so they are erased at compile time and cannot pull app code — and
// therefore `config/environment.ts` — in above the environment block below.
import type * as HarnessModule from '../helpers/booking-plan-harness';
import type { Tenant } from '../../database/entities/Tenant';
import type { Bot } from '../../database/entities/Bot';
import type { ChatSession } from '../../database/entities/ChatSession';

// ── Environment, before a single line of app code is imported ────────────────
//
// `config/environment.ts` reads process.env at IMPORT time, and `data-source.ts`
// binds DATABASE_URL at import time. Every app module below is therefore reached by a
// DYNAMIC import from inside `main()`, which under CommonJS is a `require` executed
// after this block has run. A static import would be hoisted above it and bind the
// production database.

dotenv.config({ path: path.resolve(__dirname, '../../../.env.test'), override: true });

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL is not set. It lives in api/.env.test.');
  process.exit(3);
}

const EVAL_RUN_ID = crypto.randomBytes(4).toString('hex');
const EVAL_DATABASE = `${new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '') || 'chatbot_test'}_eval_${process.pid}`;
if (!/^[a-zA-Z0-9_]+$/.test(EVAL_DATABASE)) throw new Error('Unsafe eval database name');

const evalDatabaseUrl = new URL(TEST_DATABASE_URL);
evalDatabaseUrl.pathname = `/${EVAL_DATABASE}`;
process.env.DATABASE_URL = evalDatabaseUrl.toString();

// Same Redis split `env-setup.ts` performs: the app's REDIS_URL branch ignores
// keyPrefix, so expand the test URL into the individual settings and give this run its
// own prefix. Redis-backed state (pending confirmations, refused named times) is part
// of the path under test, so it must be real and it must be ours.
if (process.env.TEST_REDIS_URL) {
  const redis = new URL(process.env.TEST_REDIS_URL);
  delete process.env.REDIS_URL;
  process.env.REDIS_HOST = redis.hostname;
  process.env.REDIS_PORT = redis.port || '6379';
  if (redis.password) process.env.REDIS_PASSWORD = redis.password;
  else delete process.env.REDIS_PASSWORD;
  process.env.REDIS_DB = redis.pathname.replace(/^\//, '') || '0';
}
process.env.REDIS_KEY_PREFIX = `eval:${EVAL_RUN_ID}:`;

// ── Flags ────────────────────────────────────────────────────────────────────

type Mode = 'live' | 'dry-run' | 'dry-run-broken';

interface Flags {
  mode: Mode;
  allowSkip: boolean;
  only: string[];
}

function parseFlags(argv: string[]): Flags {
  const only: string[] = [];
  let mode: Mode = 'live';
  let allowSkip = false;

  for (const arg of argv) {
    if (arg === '--dry-run') mode = 'dry-run';
    else if (arg === '--dry-run-broken') mode = 'dry-run-broken';
    else if (arg === '--allow-skip') allowSkip = true;
    else if (arg.startsWith('--case=')) only.push(...arg.slice('--case='.length).split(',').map((s) => s.trim().toUpperCase()));
    else if (arg.startsWith('--')) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(3);
    }
  }
  return { mode, allowSkip, only };
}

const FLAGS = parseFlags(process.argv.slice(2));

// ── The language classifier ──────────────────────────────────────────────────
//
// SYS-03 says the reply must be IN Dutch. A string match cannot express that: the
// customer's own word ("hey") is in the reply's language-neutral vocabulary, and any
// list of expected Dutch sentences would pin phrasing, which §0 forbids.
//
// So: a function-word classifier. Function words are the part of a sentence a model
// cannot avoid and cannot borrow from another language, which is why they beat content
// words here. Two properties make it safe to grade with:
//
//  * A MARGIN. The winner must beat the runner-up by `MIN_MARGIN`. Below that the
//    reply is `unknown`, the case reports SKIPPED, and the run exits non-zero. An
//    undecidable classification must never be reported as agreement.
//  * A SELF-TEST. `assertClassifierSound()` runs labelled fixtures — including the
//    short greetings SYS-03 actually produces — before any case runs, and aborts the
//    whole suite if one is misread. This is why SYS-03 cannot pass for the wrong
//    reason: a classifier degraded into always answering `nl` fails its own English
//    and French fixtures and the suite never reaches the cases.

type Language = 'en' | 'nl' | 'fr';
type Classification = Language | 'unknown';

/** Minimum lead over the runner-up. Two hits is one whole function word plus a cue. */
const MIN_MARGIN = 2;

/**
 * Function words that belong to ONE of the three languages. Words shared across two
 * of them are deliberately absent: `je` is Dutch "you" and French "I", `en` is Dutch
 * "and" and French "in", `de` belongs to both Dutch and French. Including a shared
 * word does not add signal, it adds a tie.
 */
const FUNCTION_WORDS: Record<Language, readonly string[]> = {
  en: [
    'the', 'and', 'you', 'your', 'for', 'with', 'would', 'could', 'what', 'how',
    'thanks', 'thank', 'we', 'our', 'please', 'are', 'does', 'this', 'that', 'there',
    'from', 'about', 'much', 'which', 'when', 'have', 'help', 'hello', 'available',
    'appointment', 'booking', 'time', 'price', 'cost',
  ],
  nl: [
    'het', 'een', 'ik', 'wij', 'uw', 'kunt', 'kun', 'wilt', 'wil', 'graag', 'voor',
    'hoe', 'wat', 'hallo', 'dank', 'afspraak', 'beschikbaar', 'boeken', 'welke',
    'dienst', 'ook', 'niet', 'deze', 'kan', 'maken', 'weten', 'prijs', 'kost',
    'goedemiddag', 'goedendag', 'natuurlijk', 'zijn', 'heeft', 'daarvoor', 'tijdstip',
    'waarmee', 'helpen',
  ],
  fr: [
    'les', 'une', 'vous', 'votre', 'nous', 'est', 'pouvez', 'avec', 'pour', 'comment',
    'bonjour', 'merci', 'disponible', 'quel', 'quelle', 'pas', 'des', 'aider',
    'rendez', 'heure', 'prix', 'coûte', 'sont', 'aux', 'cette', 'dans', 'plus',
    'souhaitez', 'puis', 'que',
  ],
};

/**
 * Orthographic cues, worth one hit each. They catch a short reply that carries too few
 * function words to clear the margin on its own — `Bonjour ! Comment puis-je vous
 * aider ?` is unambiguous to a reader long before it is unambiguous to a word count.
 */
const ORTHOGRAPHY: Record<Language, readonly RegExp[]> = {
  en: [/\b\w+'(s|re|ll|ve|t|d)\b/],
  nl: [/ij/, /\baa/, /oo\w/, /\bge\w{3}/],
  fr: [/[éèêàçôûù]/, /\bd'/, /\bl'/, /\bqu'/],
};

interface LanguageScores {
  language: Classification;
  scores: Record<Language, number>;
}

export function classifyLanguage(text: string): LanguageScores {
  const lower = text.toLowerCase();
  const words = new Set(lower.match(/[\p{L}']+/gu) ?? []);
  const scores: Record<Language, number> = { en: 0, nl: 0, fr: 0 };

  for (const language of ['en', 'nl', 'fr'] as const) {
    // Counted as DISTINCT words present, not occurrences: a reply that repeats "the"
    // six times is not six times more English, and occurrence counting lets one long
    // sentence outvote the whole rest of the reply.
    for (const word of FUNCTION_WORDS[language]) if (words.has(word)) scores[language] += 1;
    for (const cue of ORTHOGRAPHY[language]) if (cue.test(lower)) scores[language] += 1;
  }

  const ranked = (['en', 'nl', 'fr'] as const).slice().sort((a, b) => scores[b] - scores[a]);
  const [best, second] = ranked;
  const decided = scores[best] > 0 && scores[best] - scores[second] >= MIN_MARGIN;
  return { language: decided ? best : 'unknown', scores };
}

/**
 * Labelled fixtures the classifier must get right. Short greetings are over-
 * represented on purpose: they are the hardest input and they are exactly what SYS-03
 * elicits, so a classifier that only works on paragraphs is not fit for this suite.
 */
const CLASSIFIER_FIXTURES: ReadonlyArray<{ text: string; expect: Language }> = [
  { text: 'Hallo! Waarmee kan ik u helpen?', expect: 'nl' },
  { text: 'Goedemiddag, wilt u graag een afspraak maken?', expect: 'nl' },
  { text: 'Natuurlijk, ik kan de beschikbare tijdstippen voor deze dienst voor u boeken.', expect: 'nl' },
  { text: 'Hi there! How can I help you today?', expect: 'en' },
  { text: 'The booking costs 75 euro and that price does not include a call-out.', expect: 'en' },
  { text: 'Sure, would you like me to check what time is available for this appointment?', expect: 'en' },
  { text: 'Bonjour ! Comment puis-je vous aider aujourd\u2019hui ?', expect: 'fr' },
  { text: 'Le prix est de 75 euros, et vous pouvez choisir une heure disponible.', expect: 'fr' },
];

function assertClassifierSound(): void {
  const wrong = CLASSIFIER_FIXTURES.map((f) => ({ ...f, got: classifyLanguage(f.text) }))
    .filter((f) => f.got.language !== f.expect);
  if (wrong.length === 0) return;
  console.error('\nThe language classifier failed its own fixtures. Refusing to grade anything:\n');
  for (const f of wrong) {
    console.error(`  expected ${f.expect}, got ${f.got.language}  scores=${JSON.stringify(f.got.scores)}`);
    console.error(`    ${f.text}`);
  }
  process.exit(3);
}

/** Question SENTENCES, not `?` characters: `Really?? Which one?` asks two things. */
function questionCount(reply: string): number {
  return (reply.replace(/\?+/g, '?').match(/\?/g) ?? []).length;
}

// ── Observation: what the run actually did ───────────────────────────────────

interface LlmCallRecord {
  model: string;
  offeredTools: string[];
  requestedTools: string[];
  content: string;
}

interface ExecutedToolRecord {
  name: string;
  success: boolean;
  error?: string;
}

interface Observation {
  /** Every reply, in turn order. The LAST one is what the graders read. */
  replies: string[];
  finalReply: string;
  /** Union of the tool names the model was OFFERED across every LLM call. */
  offeredTools: string[];
  /** Union of the tool names the model ASKED for. This is the model's CHOICE. */
  requestedTools: string[];
  /** What actually ran, from the trace. A blocked request appears above, not here. */
  executedTools: ExecutedToolRecord[];
  bookings: number;
  requests: number;
  calendarCreates: number;
  emailsSent: number;
  llmCalls: number;
  model: string;
  resultTypes: string[];
}

type Verdict = 'PASS' | 'FAIL' | 'SKIPPED';

interface Grade {
  verdict: Verdict;
  reason: string;
}

function pass(reason: string): Grade { return { verdict: 'PASS', reason }; }
function fail(reason: string): Grade { return { verdict: 'FAIL', reason }; }
function skip(reason: string): Grade { return { verdict: 'SKIPPED', reason }; }

/**
 * The precondition every tool-choice case shares: the model must have been able to do
 * the forbidden thing. Without this, "the model did not call `create_booking`" is
 * satisfied by a tenant whose booking module never loaded, and BK-02 would report PASS
 * while proving nothing at all.
 */
function requireOffered(obs: Observation, tools: string[]): Grade | null {
  const missing = tools.filter((t) => !obs.offeredTools.includes(t));
  if (missing.length === 0) return null;
  return skip(
    `${missing.join(' and ')} was never offered to the model, so the case is vacuous. ` +
    `Offered: ${obs.offeredTools.join(', ') || 'none'}.`,
  );
}

const WRITE_TOOLS = ['create_booking', 'request_appointment'];

function writeEvidence(obs: Observation): string {
  return `bookings=${obs.bookings} requests=${obs.requests} calendar_creates=${obs.calendarCreates}`;
}

// ── The stub provider, for --dry-run ─────────────────────────────────────────

type ScriptStep = { text: string } | { tool: string; args: Record<string, unknown> };

// ── Cases ────────────────────────────────────────────────────────────────────
//
// The harness VALUE arrives by dynamic import (see the environment block above), so
// its type comes from the type-only namespace import instead.
type Harness = typeof HarnessModule;

interface Fixture {
  tenant: Tenant;
  bot: Bot;
  session: ChatSession;
  /** Every Service whose rows the graders read. */
  serviceIds: string[];
  /** A bookable local instant, for a script that needs real arguments. */
  slotLocal: string;
}

interface EvalCase {
  id: string;
  claim: string;
  setup: (h: Harness) => Promise<Fixture>;
  turns: string[];
  grade: (obs: Observation) => Grade;
  /** Scripted model that SHOULD pass, for `--dry-run`. */
  script: (fx: Fixture) => ScriptStep[];
  /** Scripted model that MUST fail, for `--dry-run-broken`. */
  brokenScript: (fx: Fixture) => ScriptStep[];
}

/** The AI slice every case starts from. No `apiKey`: the platform key is used. */
function aiSettings(language: Language) {
  return {
    enabled: true,
    provider: 'openai' as const,
    model: 'gpt-4o-mini',
    language,
    brandVoice: { name: 'EvalBot', tone: 'friendly and brief' },
    guardrails: {
      topicsToAvoid: [],
      escalationKeywords: [],
      confidenceThreshold: 0.5,
      maxResponseLength: 800,
      greetingMessage: 'Hi',
      fallbackMessage: 'Let me connect you with our team.',
      offHoursMessage: 'Closed.',
    },
  };
}

/** A bookable business with one Auto-book Service and a connected calendar. */
async function autoBookBusiness(
  h: Harness,
  opts: { language: Language; service?: Record<string, unknown> },
): Promise<Fixture> {
  const { tenant, bot } = await h.createPlanBusiness({
    botSettings: { ai: aiSettings(opts.language) } as never,
  });
  await h.setPlanAvailability(bot);
  await h.seedPlanCalendarCredential(bot);
  const service = await h.createPlanService(bot, {
    name: 'Drain unblocking',
    bookingMode: 'auto',
    ...(opts.service ?? {}),
  });
  const session = await h.planSession(bot, { status: 'bot' });
  return { tenant, bot, session, serviceIds: [service.id], slotLocal: h.planLocalTime(9, '10:00') };
}

function buildCases(h: Harness): EvalCase[] {
  return [
    {
      id: 'SYS-03',
      claim: 'a Dutch-configured bot answers `hey` in Dutch',
      setup: () => autoBookBusiness(h, { language: 'nl' }),
      turns: ['hey'],
      grade: (obs) => {
        const got = classifyLanguage(obs.finalReply);
        const scores = JSON.stringify(got.scores);
        if (got.language === 'unknown') {
          // Not a FAIL: the reply may be correct and merely too short to decide. An
          // undecidable measurement is reported as one, and the run still exits
          // non-zero, so it cannot be mistaken for agreement.
          return skip(`the classifier could not decide (margin < ${MIN_MARGIN}), scores=${scores}`);
        }
        return got.language === 'nl'
          ? pass(`answered in Dutch, scores=${scores}`)
          : fail(`answered in ${got.language} on a Dutch-configured bot, scores=${scores}`);
      },
      script: () => [{ text: 'Hallo! Waarmee kan ik u vandaag helpen? Wilt u graag een afspraak maken?' }],
      brokenScript: () => [{ text: 'Hi there! How can I help you today? Would you like to book an appointment?' }],
    },

    {
      id: 'SYS-04',
      claim: 'the same Dutch-configured bot answers an explicitly English message in English',
      setup: () => autoBookBusiness(h, { language: 'nl' }),
      turns: ['Good afternoon. Could you tell me what you can help me with, in English please?'],
      grade: (obs) => {
        const got = classifyLanguage(obs.finalReply);
        const scores = JSON.stringify(got.scores);
        if (got.language === 'unknown') {
          return skip(`the classifier could not decide (margin < ${MIN_MARGIN}), scores=${scores}`);
        }
        return got.language === 'en'
          ? pass(`switched to English, scores=${scores}`)
          : fail(`stayed in ${got.language} for a clearly English message, scores=${scores}`);
      },
      script: () => [{ text: 'Good afternoon! I can help you with our services and available appointment times. What would you like to book?' }],
      brokenScript: () => [{ text: 'Goedemiddag! Ik kan u helpen met onze diensten en de beschikbare tijdstippen. Wilt u graag een afspraak boeken?' }],
    },

    {
      id: 'BK-02',
      claim: 'a price question does not trigger a booking write',
      setup: () => autoBookBusiness(h, {
        language: 'en',
        service: { priceDisplayType: 'fixed', fixedPrice: 75, priceNote: 'incl. VAT' },
      }),
      turns: ['How much does drain unblocking cost? I am only asking about the price, do not book anything.'],
      grade: (obs) => {
        const vacuous = requireOffered(obs, WRITE_TOOLS);
        if (vacuous) return vacuous;

        const asked = WRITE_TOOLS.filter((t) => obs.requestedTools.includes(t));
        if (asked.length > 0) {
          return fail(`the model asked for ${asked.join(' and ')} in answer to a price question (${writeEvidence(obs)})`);
        }
        // Rows are checked as well as the request list, and not because the request
        // list is doubted: the two catch different faults. A requested-but-blocked
        // write is a MODEL fault this suite must report, and a row with no
        // corresponding request would be a write from somewhere else entirely.
        if (obs.bookings > 0 || obs.requests > 0 || obs.calendarCreates > 0) {
          return fail(`no write tool was requested, yet state changed: ${writeEvidence(obs)}`);
        }
        return pass(`answered the price question and wrote nothing (${writeEvidence(obs)}); requested ${obs.requestedTools.join(', ') || 'no tools'}`);
      },
      script: () => [{ text: 'Drain unblocking is 75 euro, incl. VAT. Would you like me to look for a time?' }],
      brokenScript: (fx) => [
        { tool: 'check_availability', args: { startDate: fx.slotLocal.slice(0, 10), endDate: fx.slotLocal.slice(0, 10), serviceId: fx.serviceIds[0] } },
        // A REAL address, not `@example.test`: the tool rejects placeholder emails
        // (`booking.tool.ts:123`), and a rejected write would leave the row half of
        // this grader unproven while the requested-tool half carried the verdict alone.
        { tool: 'create_booking', args: { serviceId: fx.serviceIds[0], startTime: fx.slotLocal, attendeeName: 'Eval Broken', attendeeEmail: h.PLAN_CUSTOMER_EMAIL } },
        { tool: 'create_booking', args: { serviceId: fx.serviceIds[0], startTime: fx.slotLocal, attendeeName: 'Eval Broken', attendeeEmail: h.PLAN_CUSTOMER_EMAIL } },
        { text: 'Booked you in!' },
      ],
    },

    {
      id: 'BK-08',
      claim: 'the model stays in Auto-book and does not offer a manual request',
      setup: () => autoBookBusiness(h, { language: 'en' }),
      turns: [
        'I would like to book drain unblocking. What have you got available?',
        'The first one you listed is fine. I am Eval Customer, eval-customer@example.test.',
      ],
      grade: (obs) => {
        // Both tools must be visible. `request_appointment` is offered unconditionally
        // by the booking module, which is what makes this case a real choice rather
        // than a tautology — and if it ever stops being offered, this skips.
        const vacuous = requireOffered(obs, ['check_availability', 'create_booking', 'request_appointment']);
        if (vacuous) return vacuous;

        if (obs.requestedTools.includes('request_appointment')) {
          return fail(`the model reached for request_appointment on an Auto-book Service (${writeEvidence(obs)})`);
        }
        if (obs.requests > 0) {
          return fail(`a request row exists on an Auto-book Service (${writeEvidence(obs)})`);
        }
        if (!obs.requestedTools.includes('check_availability')) {
          // Not a pass by omission: a model that ignored booking altogether also never
          // asks for request_appointment, so the Auto-book path has to be entered
          // before "it stayed in Auto-book" means anything.
          return skip(`the model never entered the booking path, so there was no mode to stay in; requested ${obs.requestedTools.join(', ') || 'no tools'}`);
        }
        return pass(`stayed in Auto-book: requested ${obs.requestedTools.join(', ')} (${writeEvidence(obs)})`);
      },
      script: (fx) => [
        { tool: 'check_availability', args: { startDate: fx.slotLocal.slice(0, 10), endDate: fx.slotLocal.slice(0, 10), serviceId: fx.serviceIds[0] } },
        { text: 'I can offer 10:00 that day. Shall I confirm it?' },
        { tool: 'check_availability', args: { startDate: fx.slotLocal.slice(0, 10), endDate: fx.slotLocal.slice(0, 10), serviceId: fx.serviceIds[0] } },
        { text: 'Great, that time is still free. Shall I confirm 10:00 for you?' },
      ],
      brokenScript: (fx) => [
        { tool: 'check_availability', args: { startDate: fx.slotLocal.slice(0, 10), endDate: fx.slotLocal.slice(0, 10), serviceId: fx.serviceIds[0] } },
        { text: 'I can ask the business instead.' },
        // `preferredTime` (zoneless, with seconds) and `language` are what the tool
        // declares — `startTime` returns INVALID_START_TIME and the request row would
        // never land, leaving the row half of this grader unproven.
        { tool: 'request_appointment', args: { serviceId: fx.serviceIds[0], preferredTime: `${fx.slotLocal}:00`, attendeeName: 'Eval Broken', attendeeEmail: h.PLAN_CUSTOMER_EMAIL, language: 'en' } },
        { tool: 'request_appointment', args: { serviceId: fx.serviceIds[0], preferredTime: `${fx.slotLocal}:00`, attendeeName: 'Eval Broken', attendeeEmail: h.PLAN_CUSTOMER_EMAIL, language: 'en' } },
        { text: 'I have sent your request to the business.' },
      ],
    },

    {
      id: 'SRV-02',
      claim: 'exactly one clarifying question when two Services overlap, and nothing written before it',
      setup: async () => {
        const fx = await autoBookBusiness(h, {
          language: 'en',
          service: { name: 'Drain unblocking', description: 'Unblocking a blocked drain or a blocked pipe.' },
        });
        const second = await h.createPlanService(fx.bot, {
          name: 'Drain unblocking (urgent)',
          description: 'Unblocking a blocked drain or a blocked pipe, same day.',
          bookingMode: 'auto',
        });
        return { ...fx, serviceIds: [...fx.serviceIds, second.id] };
      },
      turns: ['I need my blocked drain unblocked. Can you book that in for me?'],
      grade: (obs) => {
        if (obs.bookings > 0 || obs.requests > 0 || obs.calendarCreates > 0) {
          return fail(`state changed before the ambiguity was resolved: ${writeEvidence(obs)}`);
        }
        const asks = questionCount(obs.finalReply);
        if (asks === 0) return fail('the model asked nothing, so the ambiguous Service was never resolved');
        if (asks > 1) return fail(`the model asked ${asks} questions where the plan allows one`);
        return pass(`asked exactly one question and wrote nothing (${writeEvidence(obs)})`);
      },
      script: () => [{ text: 'I can help with that. Which one would you like, the standard drain unblocking or the urgent same-day one?' }],
      brokenScript: () => [{ text: 'Sure. Which service do you want? And what day suits you? And what is your email?' }],
    },
  ];
}

// ── Reporting ────────────────────────────────────────────────────────────────

interface CaseOutcome {
  id: string;
  claim: string;
  grade: Grade;
  obs: Observation | null;
  error?: string;
}

function reportCase(outcome: CaseOutcome): void {
  const { id, claim, grade, obs } = outcome;
  console.log(`\n[${id}] ${grade.verdict}  ${claim}`);
  console.log(`   why: ${grade.reason}`);
  if (outcome.error) console.log(`   error: ${outcome.error}`);
  if (!obs) return;

  console.log(`   model: ${obs.model}  llm calls: ${obs.llmCalls}  run results: ${obs.resultTypes.join(' → ')}`);
  console.log(`   offered:   ${obs.offeredTools.join(', ') || 'none'}`);
  console.log(`   requested: ${obs.requestedTools.join(', ') || 'none'}`);
  console.log(`   executed:  ${obs.executedTools.map((t) => `${t.name}${t.success ? '' : `(${t.error ?? 'failed'})`}`).join(', ') || 'none'}`);
  console.log(`   state:     ${writeEvidence(obs)} emails=${obs.emailsSent}`);
  // The replies are printed IN FULL and never truncated. A verdict about a model's
  // judgement has to be auditable by a human rather than taken on a regex's word, and
  // the one sentence a truncation hides is the sentence being graded.
  obs.replies.forEach((r, i) => console.log(`   reply ${i + 1}: ${r.replace(/\n+/g, ' ')}`));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function withAdminConnection<T>(fn: (admin: DataSource) => Promise<T>): Promise<T> {
  const adminUrl = new URL(TEST_DATABASE_URL!);
  adminUrl.pathname = '/postgres';
  const admin = new DataSource({ type: 'postgres', url: adminUrl.toString(), logging: false });
  await admin.initialize();
  try {
    return await fn(admin);
  } finally {
    await admin.destroy();
  }
}

async function dropEvalDatabase(): Promise<void> {
  await withAdminConnection(async (admin) => {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [EVAL_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${EVAL_DATABASE}"`);
  });
}

/** Replace exports on a live CommonJS module. */
function patchModule(mod: object, patch: Record<string, unknown>): void {
  Object.assign(mod, patch);
}

async function main(): Promise<number> {
  assertClassifierSound();

  if (FLAGS.mode === 'live' && !process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set. Use --dry-run to review the plumbing without a key.');
    return 3;
  }

  await dropEvalDatabase();
  await withAdminConnection((admin) => admin.query(`CREATE DATABASE "${EVAL_DATABASE}"`));

  try {
    return await runSuite();
  } finally {
    const { AppDataSource } = await import('../../database/data-source');
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    await dropEvalDatabase();
  }
}

/* eslint-disable-next-line max-lines-per-function */
async function runSuite(): Promise<number> {
  const { AppDataSource } = await import('../../database/data-source');
  const { prepareTestSchema } = await import('../test-schema');
  await AppDataSource.initialize();
  await prepareTestSchema(AppDataSource);

  const harness: Harness = await import('../helpers/booking-plan-harness');

  // ── Seams ──
  //
  // Three, and each one is a boundary this suite must not cross rather than a piece of
  // behaviour it is dodging. Everything between them — the prompt, the tool set, the
  // gates, the write path, the rows — is production code.

  // 1. The calendar. `PLAN_CALENDAR` is the same double the delivered vitest files use,
  //    and it is typed as the real `CalendarProvider` port, so the write path cannot
  //    pass against a fake shape. Reached here by mutating the live CommonJS exports,
  //    which is what `vi.mock` does for the test files; consumers read these bindings
  //    at CALL time, so the patch reaches code imported before this line.
  const calendarProvider = await import('../../scheduler/calendar-provider');
  patchModule(calendarProvider, harness.planCalendarMockModule());

  // 2. Outbound email. A case that FAILS by booking would otherwise post to Resend.
  const emailsSent: unknown[] = [];
  const automations = await import('../../automations');
  patchModule(automations, {
    initializeAutomations: () => undefined,
    getEmailService: () => ({
      async send(payload: unknown) {
        emailsSent.push(payload);
        return { success: true, messageId: `eval-${emailsSent.length}` };
      },
    }),
  });

  // 3. The LLM. Wrapped rather than replaced in live mode: the wrapper is how the
  //    model's REQUESTED tool calls are observed, which is the signal BK-02 and BK-08
  //    are actually graded on. In dry-run it is also where the script is served.
  const calls: LlmCallRecord[] = [];
  let script: ScriptStep[] = [];
  let scriptIndex = 0;
  const dryRun = FLAGS.mode !== 'live';

  let delegate: (m: unknown[], o: { model: string; tools?: { name: string }[] }) => Promise<{
    content: string;
    usage: { promptTokens: number; completionTokens: number };
    toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
    finishReason: 'stop' | 'tool_calls' | 'length';
  }>;

  if (dryRun) {
    // Localization is patched to identity in dry-run only, so the scripted queue is
    // never consumed by a translate call the case did not ask for. In live mode the
    // real localizer runs, because it is production behaviour.
    const localize = await import('../../llm/localize');
    patchModule(localize, { localizeMessage: async (message: string) => message });

    delegate = async () => {
      const step = script[scriptIndex++];
      if (!step) {
        return { content: '(script exhausted)', usage: { promptTokens: 0, completionTokens: 0 }, finishReason: 'stop' as const };
      }
      if ('text' in step) {
        return { content: step.text, usage: { promptTokens: 0, completionTokens: 0 }, finishReason: 'stop' as const };
      }
      return {
        content: '',
        usage: { promptTokens: 0, completionTokens: 0 },
        toolCalls: [{ id: `eval_tc_${scriptIndex}`, name: step.tool, arguments: step.args }],
        finishReason: 'tool_calls' as const,
      };
    };
  } else {
    const { OpenAIProvider } = await import('../../llm/openai.provider');
    const base = new OpenAIProvider(process.env.OPENAI_API_KEY!);
    delegate = (messages, options) => base.chat(messages as never, options as never);
  }

  const evalProvider = {
    async chat(messages: unknown[], options: { model: string; tools?: { name: string }[] }) {
      const response = await delegate(messages, options);
      calls.push({
        model: options.model,
        offeredTools: (options.tools ?? []).map((t) => t.name),
        requestedTools: (response.toolCalls ?? []).map((t) => t.name),
        content: response.content ?? '',
      });
      return response;
    },
  };
  const providerFactory = await import('../../llm/provider-factory');
  patchModule(providerFactory, { getProvider: () => evalProvider });

  // ── The production agent ──
  const { AgentService } = await import('../../agent/agent.service');
  const { ToolRegistry } = await import('../../agent/tool-registry');
  const { PromptBuilder } = await import('../../agent/prompt-builder');
  await import('../../modules');

  const executed: ExecutedToolRecord[] = [];
  const agent = new AgentService(
    new ToolRegistry(),
    new PromptBuilder(),
    { record: async () => undefined, isOverBudget: async () => false } as never,
    {
      // The trace is the seam that reports which tools actually RAN, including the
      // result. Nothing is asserted about the trace ROW, so the save is skipped.
      save: async (trace: { iterations: { toolCalls: { name: string; result: { success: boolean; error?: string } }[] }[] }) => {
        for (const it of trace.iterations) {
          for (const tc of it.toolCalls) {
            executed.push({ name: tc.name, success: tc.result.success, error: tc.result.error });
          }
        }
      },
    } as never,
  );

  const cases = buildCases(harness).filter((c) => FLAGS.only.length === 0 || FLAGS.only.includes(c.id));
  if (cases.length === 0) {
    console.error(`No case matched --case=${FLAGS.only.join(',')}`);
    return 3;
  }

  console.log(`\n=== booking plan · live eval ===`);
  console.log(`mode: ${FLAGS.mode}   database: ${EVAL_DATABASE}   cases: ${cases.map((c) => c.id).join(', ')}`);

  const outcomes: CaseOutcome[] = [];

  for (const evalCase of cases) {
    // `PLAN_CALENDAR` is module state, not a row, so it survives everything else and
    // must be reset per case. Each case seeds its OWN tenant, which is why no TRUNCATE
    // is needed for the database half.
    harness.PLAN_CALENDAR.reset();
    calls.length = 0;
    executed.length = 0;
    emailsSent.length = 0;
    scriptIndex = 0;

    let obs: Observation | null = null;
    let grade: Grade;
    let errorText: string | undefined;

    try {
      const fixture = await evalCase.setup(harness);
      script = FLAGS.mode === 'dry-run-broken' ? evalCase.brokenScript(fixture) : evalCase.script(fixture);

      const replies: string[] = [];
      const resultTypes: string[] = [];
      const history: { role: 'user' | 'assistant'; content: string }[] = [];

      for (const turn of evalCase.turns) {
        const result = await agent.run(turn, fixture.session as never, fixture.tenant as never, history as never);
        const reply = replyTextOf(result);
        resultTypes.push(result.type);
        replies.push(reply);
        history.push({ role: 'user', content: turn }, { role: 'assistant', content: reply });
      }

      let bookings = 0;
      let requests = 0;
      for (const serviceId of fixture.serviceIds) {
        bookings += await harness.bookingCount(serviceId);
        requests += await harness.requestCount(serviceId);
      }

      obs = {
        replies,
        finalReply: replies[replies.length - 1] ?? '',
        offeredTools: [...new Set(calls.flatMap((c) => c.offeredTools))].sort(),
        requestedTools: [...new Set(calls.flatMap((c) => c.requestedTools))].sort(),
        executedTools: [...executed],
        bookings,
        requests,
        calendarCreates: harness.PLAN_CALENDAR.creates.length,
        emailsSent: emailsSent.length,
        llmCalls: calls.length,
        model: calls[0]?.model ?? 'unknown',
        resultTypes,
      };
      grade = evalCase.grade(obs);
    } catch (error) {
      errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      // An exception is NOT a pass and NOT a skip. The case could not be measured, so
      // it fails and the run exits non-zero.
      grade = fail('the case could not be measured');
    }

    const outcome: CaseOutcome = { id: evalCase.id, claim: evalCase.claim, grade, obs, error: errorText };
    outcomes.push(outcome);
    reportCase(outcome);
  }

  return summarise(outcomes);
}

/** The reply text, from whichever `AgentResult` variant came back. */
function replyTextOf(result: Record<string, unknown>): string {
  for (const field of ['content', 'message', 'fallbackMessage']) {
    const value = result[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function summarise(outcomes: CaseOutcome[]): number {
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0 };
  for (const o of outcomes) counts[o.grade.verdict] += 1;

  console.log(`\n─── summary ───`);
  console.log(`PASS ${counts.PASS}   FAIL ${counts.FAIL}   SKIPPED ${counts.SKIPPED}`);
  for (const o of outcomes) console.log(`  ${o.grade.verdict.padEnd(7)} ${o.id}`);

  if (FLAGS.mode === 'dry-run-broken') {
    // The graders are on trial here, not the model. Every case is fed the forbidden
    // behaviour, so every case must report FAIL. A PASS or a SKIP means a grader is
    // not discriminating, which is the one failure mode that would let this whole
    // suite go green while proving nothing.
    const notFailed = outcomes.filter((o) => o.grade.verdict !== 'FAIL');
    if (notFailed.length > 0) {
      console.log(`\nBROKEN-MODE FAILURE: these graders did not reject the forbidden behaviour: ${notFailed.map((o) => `${o.id}(${o.grade.verdict})`).join(', ')}\n`);
      return 1;
    }
    console.log(`\nBROKEN-MODE OK: every grader rejected the forbidden behaviour.\n`);
    return 0;
  }

  if (counts.FAIL > 0) {
    console.log(`\nFAIL\n`);
    return 1;
  }
  if (counts.SKIPPED > 0 && !FLAGS.allowSkip) {
    console.log(`\nSKIPPED cases and no --allow-skip: a suite that goes green when nothing ran is worse than no suite.\n`);
    return 2;
  }
  console.log(`\nPASS\n`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error('\nFATAL:', error);
      process.exit(3);
    },
  );
}
