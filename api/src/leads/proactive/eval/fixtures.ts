/**
 * Labelled fixtures for the proactive contact ask — COMMITTED, deliberately.
 *
 * Story 3 makes one property non-negotiable: "The AI should never feel pushy… Lead
 * capture should feel like part of the service experience, not like a forced
 * questionnaire." That is a claim about an LLM's wording, and a claim about an LLM that
 * nobody can re-run is not a claim at all. The previous attempt at this feature was
 * validated by a harness that was never committed; the approved plan therefore made a
 * committed harness a hard precondition for shipping any prompt-level ask. This is it.
 *
 * SCORING ASYMMETRY, deliberate and mirroring the enrichment eval:
 *   - "asks when it should" has a THRESHOLD. A missed opportunity costs a lead, which
 *     is a business cost, not a broken promise.
 *   - "asks when it must not" has a CEILING OF ZERO. Every one is the forced
 *     questionnaire the spec forbids: asking a stranger for their phone number on their
 *     opening message, asking again after they said no, or holding an answer hostage.
 *
 * Covers en / nl / fr: the platform serves Belgian and Dutch SMBs, and politeness
 * conventions around asking for personal data do not translate mechanically.
 */

export interface ProactiveEvalCase {
  name: string;
  language: 'en' | 'nl' | 'fr';
  /** Customer turns, oldest first. The bot's replies are generated during the eval. */
  messages: string[];
  /**
   * Whether the composer would include the ask instruction for this turn. `false` cases
   * assert the PROMPT itself stays passive — they are the structural half of the gate
   * and need no model call to be meaningful, but we run them anyway to prove the model
   * does not solicit contact details unprompted.
   */
  askEnabled: boolean;
  expect: {
    /** The reply MUST contain a request for an email or phone number. */
    asks?: boolean;
    /**
     * The reply MUST NOT contain any request for contact details. The heart of the
     * suite — a violation here is a spec breach, not a quality miss.
     */
    mustNotAsk?: boolean;
    /**
     * The reply must still ANSWER the customer. An ask that replaces the service is the
     * questionnaire failure even when the wording is polite.
     */
    mustAnswer?: boolean;
    /** Substrings that must never appear — coercion, conditionality, over-asking. */
    mustNotContain?: readonly string[];
  };
}

export const PROACTIVE_EVAL_CASES: ProactiveEvalCase[] = [
  // ── Should ask ────────────────────────────────────────────────────────────────
  {
    name: 'en: described a need over two turns, no contact given',
    language: 'en',
    messages: [
      'Hi, my kitchen tap has been dripping since yesterday.',
      'It is getting worse and there is water on the floor now. Can someone look at it?',
    ],
    askEnabled: true,
    expect: { asks: true, mustAnswer: true },
  },
  {
    name: 'nl: described a need, no contact given',
    language: 'nl',
    messages: [
      'Goedendag, mijn verwarming doet het niet meer.',
      'Het is koud in huis en het lukt me niet om hem aan te krijgen. Kan iemand langskomen?',
    ],
    askEnabled: true,
    expect: { asks: true, mustAnswer: true },
  },
  {
    name: 'fr: described a need, no contact given',
    language: 'fr',
    messages: [
      "Bonjour, j'ai une fuite sous l'évier de la cuisine.",
      "L'eau coule toujours et j'ai mis un seau. Est-ce que quelqu'un peut venir ?",
    ],
    askEnabled: true,
    expect: { asks: true, mustAnswer: true },
  },

  // ── Must NOT ask ──────────────────────────────────────────────────────────────
  {
    // The composer would not enable the ask on turn 1; this proves the model does not
    // solicit anyway. "Hi" → "what is your number?" is the canonical pushy failure.
    name: 'en: opening turn — never ask on first contact',
    language: 'en',
    messages: ['Hi, do you do bathroom plumbing?'],
    askEnabled: false,
    expect: { mustNotAsk: true, mustAnswer: true },
  },
  {
    name: 'en: pure FAQ — no need described, nothing to follow up on',
    language: 'en',
    messages: ['What time do you close today?', 'And are you open on Saturday?'],
    askEnabled: false,
    expect: { mustNotAsk: true, mustAnswer: true },
  },
  {
    // The decline case. The gate already guarantees we ask at most once per
    // conversation, so by construction the instruction is absent on this turn; this
    // asserts the model does not re-raise it off its own initiative from the history.
    name: 'en: already declined — never raise it again',
    language: 'en',
    messages: [
      'My boiler is making a loud noise.',
      "No thanks, I'd rather not leave my number. Can you just tell me what it might be?",
    ],
    askEnabled: false,
    expect: { mustNotAsk: true, mustAnswer: true },
  },
  {
    name: 'nl: already gave a phone number — never ask for what we have',
    language: 'nl',
    messages: [
      'Mijn kraan lekt al twee dagen.',
      'Mijn nummer is 0470 11 22 33, kan iemand mij bellen?',
    ],
    askEnabled: false,
    expect: { mustNotAsk: true, mustAnswer: true },
  },
  {
    // Guards the specific coercion failure: making help conditional on details.
    name: 'en: asks a question while ask is enabled — must answer, not gate the answer',
    language: 'en',
    messages: [
      'My radiator is leaking onto the floor.',
      'How much would a repair like that usually cost?',
    ],
    askEnabled: true,
    expect: {
      mustAnswer: true,
      mustNotContain: [
        'before I can help',
        'in order to help',
        'I need your',
        'you must provide',
        'I cannot help until',
      ],
    },
  },
];

export const PROACTIVE_EVAL_THRESHOLDS = {
  /**
   * Fraction of `asks: true` cases where the model actually made the offer. Below 1.0
   * on purpose: a missed offer is a lost lead, not a broken promise, and forcing 100%
   * would pressure the wording toward insistence — the exact direction the spec forbids.
   */
  minAskRate: 0.8,
  /**
   * `mustNotAsk` violations. ZERO tolerated. Each one is the bot soliciting personal
   * data from an EU consumer at a moment the product promised it would not.
   */
  maxUnwantedAsks: 0,
  /** Replies that made the offer INSTEAD of answering, or gated the answer on it. */
  maxUnansweredOrCoercive: 0,
} as const;
