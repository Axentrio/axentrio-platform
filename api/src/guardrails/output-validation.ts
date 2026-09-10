// PURE output validator — runs on an AI-GENERATED reply BEFORE it is sent to a
// customer (AC14, R35). No I/O, no LLM, no network: same input → same output.
//
// DESIGN BIAS: HIGH PRECISION. A violation can cause the reply to be replaced by
// a generic fallback (enforce mode), so a false positive is a real product
// regression — worse than missing a borderline case, because the prompt layer
// (platform rules emitted last, KB/extra_info fenced as untrusted) is the
// PRIMARY defense and this is only a secondary net. We therefore match ONLY
// signals that are essentially never legitimate in a customer-facing reply, and
// reuse the hardened inbound link/credential primitives so the two directions
// cannot drift. Invented prices and fake booking confirmations are checked only
// when the caller supplies the turn state needed to prove them.

import { detectUnsafeLinkHosts } from "./classify";

export type OutputViolationFamily =
  | "leaked_internals"
  | "plan_leakage"
  | "credential_solicitation"
  | "unsafe_link"
  | "fake_booking_confirmation"
  | "fake_request_confirmation"
  | "invented_price";

export interface OutputViolation {
  family: OutputViolationFamily;
  evidence: string;
}

export interface OutputValidationResult {
  ok: boolean;
  violations: OutputViolation[];
}

export interface OutputValidationContext {
  /** True only when a CONFIRMED Booking was recorded during this Agent run. */
  bookingRecorded: boolean;
  /**
   * True only when a Request, lead or handoff row was recorded during this Agent run, or
   * during an earlier turn of the same conversation - so a reply that repeats an earlier,
   * true "your request has been forwarded" is not judged a new claim.
   *
   * Separate from `bookingRecorded` because the two claims are separately falsifiable:
   * `docs/booking-rules.md:223` — "`CONFIRMATION_REQUIRED` is not a Booking" — and a
   * disconnected calendar downgrades an Auto-book create to a Request, so one run can
   * honestly say "your request is in" and dishonestly say "you are booked".
   */
  requestRecorded: boolean;
  /**
   * True only when a booking tool recorded a Request, not a Booking, during this Agent run.
   * That makes "your booking has been submitted" true, and a lead or handoff does not.
   */
  bookingRequestRecorded: boolean;
  /** True when price-bearing catalog or KnowledgeBase content reached this run. */
  priceContextLoaded: boolean;
}

/** High-precision numeric currency assertion; bare words such as "price" do not count. */
export function containsCurrencyAmount(text: string): boolean {
  return /(?:€|£|\$)\s?\d{1,7}(?:[.,]\d{1,2})?\b|\b(?:EUR|USD|GBP)\s?\d{1,7}(?:[.,]\d{1,2})?\b|\b\d{1,7}(?:[.,]\d{1,2})?\s?(?:(?:EUR|USD|GBP)\b|(?:€|£|\$)(?!\w))/i.test(
    text,
  );
}

/** High-precision detector for a reply claiming a booking mutation completed now. */
export function claimsBookingDone(text: string): boolean {
  // Only a *booking* submission counts — a lead/handoff `request` is not a
  // booking mutation.
  return claimsBookingConfirmed(text) || /\byour booking has been submitted\b/.test(text.toLowerCase());
}

/**
 * `claimsBookingDone` without "your booking has been submitted": the sentences only a
 * CONFIRMED Booking makes true. A Request makes that one sentence true as well.
 */
export function claimsBookingConfirmed(text: string): boolean {
  const t = text.toLowerCase();
  return [
    // Completed booking mutation only — bare `scheduled` (reminder/follow-up) is
    // an everyday reply, not a booking claim (review FP round 2).
    /\bi(?:['’]ve| have) (?:successfully )?booked\b/,
    // `confirmed your booking/appointment` — but NOT when it merely states
    // availability ("your appointment is available tomorrow").
    /\bi(?:['’]ve| have) (?:successfully )?confirmed your (?:booking|appointment)\b(?!\s+is\s+available)/,
    /\byour booking has been (?:booked|confirmed)\b/,
    // Dutch: `geboekt/gereserveerd` may stand alone ("ik heb geboekt" is a
    // completed claim), but `gepland/ingepland/bevestigd` need the booking noun
    // — otherwise "ik heb gepland om je te bellen" / "ik heb bevestigd dat we
    // open zijn" false-positive (review FP round 2).
    /\bik heb (?:je|uw|het|de|een)?\s?(?:afspraak|reservering|boeking)?\s?(?:geboekt|gereserveerd)\b/,
    /\bik heb (?:je|uw|het|de|een)?\s?(?:afspraak|reservering|boeking)\s?(?:gepland|ingepland|bevestigd)\b/,
    // Live 2026-09: reschedule set to not_allowed, the model still said
    // "Uw wijziging is bevestigd" while the diary never moved.
    // `Je afspraak is bevestigd` and `afspraak staat nu op` stay out — the
    // first is a prior confirmation the bot may quote; the second is how it
    // tells the customer the original appointment still stands.
    /\b(?:je|uw) wijziging is bevestigd\b/,
    /\byour (?:change|reschedule) (?:is|has been) confirmed\b/,
    /\bi(?:['’]ve| have) (?:successfully )?(?:rescheduled|moved) (?:your )?(?:appointment|booking)\b/,
    /\byour appointment has been (?:moved|rescheduled)\b/,
  ].some((re) => re.test(t));
}

/**
 * The request twin of `claimsBookingDone`: a reply telling the customer their request is
 * already with the business.
 *
 * It exists because `claimsBookingDone` deliberately excludes request language — a lead or a
 * handoff really is not a booking mutation — and NOTHING then constrained the sentence at all.
 * "Your request has been submitted" is honest when a Request, lead or handoff row was written
 * and a lie when the run recorded nothing, and only `requestRecorded` can tell those apart.
 *
 * SAME PRECISION BIAS as every matcher in this file, so two whole families stay out:
 *  - FUTURE INTENT. "I'll forward your request to our business owner" and "I'll go ahead and
 *    request your phone number" promise a next step; they assert no row, and both are pinned
 *    as legitimate replies in the unit corpus.
 *  - A BARE ACKNOWLEDGEMENT. "Thanks, I have your details" is conversation, not a claim about
 *    what reached the owner, so only a completed transmission verb counts.
 *  - A CONDITION, A SEQUENCE OR AN EMBEDDED QUESTION. "Once all your details have been
 *    submitted, we reply within 48 hours" and "I can't confirm whether your request has been
 *    forwarded" report nothing, so a claim that a lead-in of its own language introduces does
 *    not count. A lead-in whose own clause ends first ("Before you go I've passed your request
 *    on") introduces nothing, so the claim after it still counts.
 *
 * KNOWN RESIDUALS. A regex has no parse tree, so three shapes stay wrong on purpose. Each is
 * pinned with `it.fails` in the unit corpus and written into the SYS-07 row:
 *  - A join word after a lead-in's own clause hides a real claim: "When I checked I saw that
 *    your request has been forwarded." A clause end at "and" or "that" would block "Once we see
 *    that your request has been submitted, we reply within 48 hours."
 *  - A negated report is blocked: "I can't confirm that your request has been forwarded." Only
 *    a negation check could tell it from "I can confirm that ...", and recall wins that tie.
 *  - The vocabulary is closed, so the same claim in other words passes: "I've forwarded your
 *    question to the owner.", or the Dutch inversion "Inmiddels is uw aanvraag doorgestuurd."
 */
export function claimsRequestForwarded(text: string): boolean {
  const t = text.toLowerCase();
  return REQUEST_FORWARDED.some(({ claim, leadIn }) =>
    [...t.matchAll(claim)].some((m) => !leadIn.test(clauseBefore(t, m.index ?? 0))),
  );
}

/** The text from the start of the clause that holds `end` up to `end`, and never further back. */
function clauseBefore(t: string, end: number): string {
  return t.slice(0, end).split(/[.!?;:,\n—–]| - | but | maar | mais /).pop() ?? '';
}

/**
 * A conjunction that introduces the claim itself. Between the two stands nothing, or one
 * closed filler ("once all your details", "when exactly your request"), or an earlier clause
 * that a join word ties to the claim ("once the form is complete and your request"). Any other
 * words form a clause of their own, and the claim is a new main clause.
 *
 * One list per language, because the words collide: Dutch "of" is "whether", but English "of"
 * is the quantifier in "All of your details have been submitted.", which is a claim.
 */
function subordinateLeadIn(leadIns: string, fillers: string, joins: string): RegExp {
  return new RegExp(`\\b(?:${leadIns})\\s+(?:(?:${fillers})\\s+|.*\\s(?:${joins})\\s+)?$`);
}

const EN_LEAD_IN = subordinateLeadIn(
  'once|after|when|whenever|as soon as|if|whether|before|until|unless',
  '(?:all|most|some|any|each|both|the rest)(?: of)?|exactly',
  'and|that',
);
const NL_LEAD_IN = subordinateLeadIn('zodra|nadat|als|wanneer|indien|of|voordat|totdat', 'al|precies', 'en|dat');
const FR_LEAD_IN = subordinateLeadIn(
  'une fois que|dès que|après que|quand|lorsque|si',
  'exactement',
  'et(?: que)?|que',
);

// One optional completion adverb, from a CLOSED list. Never a wildcard: an open gap between
// the auxiliary and the participle would admit "has not been" and "is nog niet".
const EN_ADVERB = '(?:(?:successfully|now|just|already|also) )?';
const NL_ADVERB = '(?:(?:succesvol|nu|zojuist|net|al|ook) )?';
const FR_ADVERB = '(?:(?:bien|déjà) )?';
// Dutch puts the recipient before a clause-final participle: "is naar de eigenaar doorgestuurd".
// The article is required, so the slot holds a recipient and never a negation.
const NL_RECIPIENT = "(?:(?:naar|aan) (?:het|de|ons|onze) [a-zà-ÿ'’-]+ )?";

const REQUEST_FORWARDED: Array<{ claim: RegExp; leadIn: RegExp }> = [
  // English, passive: the noun must be the customer's ask, so "your booking has been
  // confirmed" stays with `claimsBookingDone` and is judged against the Booking flag.
  {
    claim: new RegExp(
      `\\byour (?:request|enquiry|inquiry|details|message) (?:has|have) ${EN_ADVERB}been ${EN_ADVERB}(?:submitted|forwarded|sent|logged|recorded|passed(?: on| along)?)\\b`,
      'g',
    ),
    leadIn: EN_LEAD_IN,
  },
  // English, active. `(?:your|the|this)` is required after the verb: without it,
  // "I've sent you the opening hours" would match on `sent` alone.
  {
    claim: new RegExp(
      `\\bi(?:['’]ve| have) ${EN_ADVERB}(?:submitted|forwarded|sent|logged|recorded|passed(?: on| along)?) (?:your|the|this) (?:request|enquiry|inquiry|details|message)\\b`,
      'g',
    ),
    leadIn: EN_LEAD_IN,
  },
  // Dutch. Present-perfect and passive, matching how the tenants this platform serves
  // actually phrase it ("uw aanvraag is doorgestuurd naar het team"). The passive needs the
  // customer's own pronoun: "de gegevens zijn geregistreerd bij de KvK" is not their ask.
  {
    claim: new RegExp(
      `\\b(?:je|jouw|uw) (?:aanvraag|verzoek|gegevens|bericht) (?:is|zijn|werd|werden) ${NL_ADVERB}${NL_RECIPIENT}(?:doorgestuurd|doorgegeven|verstuurd|ingediend|geregistreerd)\\b`,
      'g',
    ),
    leadIn: NL_LEAD_IN,
  },
  {
    claim: new RegExp(
      `\\bik heb ${NL_ADVERB}(?:je|jouw|uw|de) (?:aanvraag|verzoek|gegevens|bericht) ${NL_ADVERB}${NL_RECIPIENT}(?:doorgestuurd|doorgegeven|verstuurd|ingediend|geregistreerd)\\b`,
      'g',
    ),
    leadIn: NL_LEAD_IN,
  },
  // French. `demande` only — `coordonnées` alone is contact detail, not an ask.
  // Both apostrophes, because a model writes either and a miss here is a lie shipped.
  {
    claim: new RegExp(
      `\\bvotre demande a ${FR_ADVERB}été ${FR_ADVERB}(?:transmise|envoyée|enregistrée|soumise|transférée)\\b`,
      'g',
    ),
    leadIn: FR_LEAD_IN,
  },
  {
    claim: new RegExp(`\\bj['’]ai ${FR_ADVERB}(?:transmis|envoyé|enregistré|soumis) (?:votre|la) demande\\b`, 'g'),
    leadIn: FR_LEAD_IN,
  },
];

/**
 * A reply that declares a NAMED DATE shut, full, or impossible.
 *
 * The availability twin of `claimsBookingDone`, and it exists for the same reason: a sentence
 * the model had no evidence for. Observed on production - asked for Wednesday 16 September, an
 * auto-book bot answered that the date "valt op een sluitingsdag" and offered to submit a manual
 * request. The trace for that turn holds ZERO tool calls, and the day in fact had sixteen free
 * slots. Every existing availability guard keys off a `check_availability` result, so none of
 * them can see a turn that never called it.
 *
 * A SPECIFIC DATE IS THE WHOLE TRIGGER, and the narrowness is the point. "We are closed on
 * Sundays" is answerable from the opening hours already in the prompt and must stay legal. A
 * calendar date is not: `dateOverrides` exist precisely so one date can differ from its weekday,
 * and bookings and day caps are invisible to the prompt. Nothing but the tool can settle it.
 *
 * Both halves must be present, so "Wednesday 16 September at 10:00 works" is untouched and
 * "we are fully booked at the moment" is untouched. Bilingual because the tenant this was found
 * on replies in Dutch, and an English-only guard would never have fired.
 */
export function claimsDatedUnavailability(text: string): boolean {
  const t = text.toLowerCase();
  // A day-of-month paired with a month name, in either order: "16 september", "september 16".
  const MONTH =
    '(?:january|february|march|april|may|june|july|august|september|october|november|december' +
    '|januari|februari|maart|mei|juni|juli|augustus|oktober|december)';
  const namesADate =
    new RegExp(`\\b\\d{1,2}\\s+${MONTH}\\b`).test(t) ||
    new RegExp(`\\b${MONTH}\\s+\\d{1,2}\\b`).test(t) ||
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(t);
  if (!namesADate) return false;
  return [
    // English.
    /\b(?:is|are|we(?:'re| are)|they(?:'re| are))\s+(?:closed|fully booked|unavailable)\b/,
    /\bfully booked\b/,
    /\bclosing day\b/,
    /\bno (?:availability|slots|times|appointments) (?:on|for|that)\b/,
    // Dutch. `sluitingsdag` is what production actually said.
    /\bsluitingsdag\b/,
    /\b(?:is|zijn)\s+(?:we\s+)?gesloten\b/,
    /\bgesloten\b.*\b(?:dag|dan|die dag)\b/,
    /\bvolgeboekt\b/,
    /\bniet\s+(?:beschikbaar|mogelijk|open)\b/,
    /\bgeen\s+(?:beschikbaarheid|plek|tijden|afspraken)\b/,
  ].some((re) => re.test(t));
}

/**
 * A reply that OFFERS to file the appointment as a request for the owner to review.
 * BK 2026-09-08: Auto-book, same-day, name + email given, first reply: "I can submit it as a
 * request; it will not be confirmed until the business reviews it". Zero tool calls. Not a
 * dated-unavailability claim, so the guard above never saw it. Narrow on purpose: sentences
 * that say a request WAS filed are the legitimate after-the-tool wording and stay untouched.
 */
export function offersManualRequest(text: string): boolean {
  const t = text.toLowerCase();
  return [
    // English
    /\b(?:as|into) an? (?:manual |appointment |booking )?request\b/,
    /\b(?:submit|log|register|put in|send) (?:it|this|that|the appointment|your appointment) as an? request\b/,
    /\b(?:not|won't|will not) be confirmed until\b/,
    // Dutch
    /\bals (?:een )?aanvraag\b/,
    /\baanvraag (?:indienen|doorgeven|registreren|noteren|doorsturen)\b/,
    /\b(?:pas|nog niet) bevestigd (?:zodra|tot|totdat|nadat|wanneer)\b/,
    // French
    /\b(?:en tant que|comme) (?:une )?demande\b/,
    /\bne sera (?:pas )?confirm[ée]e? (?:qu'|que |tant que|avant)/,
  ].some((re) => re.test(t));
}

// Internal markers that have NO legitimate place in a reply to a customer.
// The fence markers + section headers mirror compose-system-prompt.ts exactly,
// so a leak of the assembled system prompt is caught verbatim; the tool/id/
// secret patterns are infrastructure details a reply must never expose.
const INTERNAL_MARKERS: Array<{ re: RegExp; reason: string }> = [
  // Prompt fences (unique to our composer — impossible in an organic reply).
  {
    re: /<<<\s*(?:KNOWLEDGE|EXTRA_INFO)\b|\b(?:KNOWLEDGE|EXTRA_INFO)\s*>>>/i,
    reason: "prompt fence marker",
  },
  // Distinctive composed section headers (mirror compose-system-prompt.ts).
  {
    re: /##\s*PLATFORM RULES \(non-negotiable\)/i,
    reason: "platform-rules header",
  },
  {
    re: /##\s*KNOWLEDGE BASE \(reference data/i,
    reason: "knowledge-base section header",
  },
  {
    re: /##\s*ADDITIONAL CONTEXT \(reference only/i,
    reason: "additional-context header",
  },
  { re: /##\s*GUARDRAILS\b/i, reason: "guardrails header" },
  {
    re: /##\s*FORMATTING RULES \(CRITICAL/i,
    reason: "formatting-rules header",
  },
  { re: /\bLANGUAGE \(read first\):/i, reason: "language-directive header" },
  // Internal tool names (all built-in agent tools — a reply must never name them).
  {
    re: /\b(?:kb_search|capture_lead|escalate_to_human|check_availability|create_booking|request_appointment|list_bookings|reschedule_booking|cancel_booking|update_booking)\b/,
    reason: "internal tool name",
  },
  // Internal id field names (snake_case ids that only exist server-side).
  {
    re: /\b(?:tenant_id|session_id|bot_id|conversation_id)\b/,
    reason: "internal id field",
  },
  // Secret / API-key shapes (high-precision — these strings are always secrets).
  // OpenAI keys include sk-proj-/sk-svcacct-/sk-admin- prefixes (codex).
  {
    re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9]{16,}\b/,
    reason: "openai-style secret key",
  },
  {
    re: /\bsk_(?:live|test|prod)_[A-Za-z0-9]{8,}\b/i,
    reason: "stripe-style secret key",
  },
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    reason: "jwt token",
  },
  { re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/, reason: "bearer token" },
  // Internal automation infrastructure.
  {
    re: /\bwebhookUrl\b|\bn8n\.(?:io|com|cloud)\b/i,
    reason: "internal webhook/automation reference",
  },
];

// Subscription-plan leakage (R12/AC5) — end customers must never be shown plan
// names, upgrade prompts, or plan-gated-feature messaging. The bot's prompt does
// NOT contain these plan names, so the true-positive base rate is low; the risk
// here is the OPPOSITE — false positives on service businesses whose own
// packages share the words ("our pro stylist", "essential service plan"). So we
// require the plan name to sit in an explicit subscription/upgrade context, and
// restrict to the real plan names (Essential/Pro/Enterprise). Bounded negated
// classes ({0,30}) keep matching linear (ReDoS-safe), per classify.ts.
// Plan leakage is the WEAKEST family: the customer-facing prompt never contains
// our plan names, so the true-positive base rate is ~zero, while SMB package /
// membership copy collides heavily ("our Pro plan includes…", "upgrade your
// maintenance plan", "Pro stylist", "essential oils"). Bare "upgrade … plan" and
// even "<Plan> plan" alone are therefore NOT enough (codex). We require BOTH a
// real plan NAME (Essential/Pro/Enterprise) + plan/tier/subscription AND explicit
// CAPABILITY-GATING context (a "feature", an availability denial, or a
// "to use/access/enable/unlock") nearby — the actual R12/AC5 leak shape. Legit
// upsells ("includes…", "covers…") and non-plan uses can't satisfy that combo.
const PLAN = "Essential|Pro|Enterprise";
const PLAN_NAME = `(?:${PLAN})\\s+(?:plan|tier|subscription)`;
const PLAN_LEAKAGE: Array<{ re: RegExp; reason: string }> = [
  {
    re: new RegExp(`\\bfeature\\b[^.!?\\n]{0,40}\\b${PLAN_NAME}\\b`, "i"),
    reason: "gates a feature behind a plan",
  },
  {
    re: new RegExp(`\\b${PLAN_NAME}\\b[^.!?\\n]{0,40}\\bfeature\\b`, "i"),
    reason: "gates a feature behind a plan",
  },
  {
    re: new RegExp(
      `\\b(?:not (?:available|included|supported)|only (?:available|included|on)|available only on|require[sd]?|need(?:s|ed)?)\\b[^.!?\\n]{0,30}\\b${PLAN_NAME}\\b`,
      "i",
    ),
    reason: "gates a feature behind a plan",
  },
  {
    re: new RegExp(
      `\\b${PLAN_NAME}\\b[^.!?\\n]{0,30}\\bto (?:use|access|enable|unlock)\\b`,
      "i",
    ),
    reason: "gates a feature behind a plan",
  },
];

// Output credential solicitation — fully self-contained (does NOT reuse the
// inbound helper, which still matches bare "credentials" = professional
// qualifications, e.g. "provide your credentials as a therapist"; codex). Same
// "solicits a secret, not merely mentions one" bar as inbound, but over a
// narrowed OUTPUT noun list: bare "credentials" dropped (only "login
// credentials" is a secret), and "password" excludes policy/help phrasings
// ("password reset/policy"). Contact details (name/email/phone) are never here.
const SECRET_NOUN =
  "password(?!\\s+(?:reset|policy|requirement|protection|manager))|passcode|otp|one[-\\s]?time\\s?(?:pass)?code|2fa|two[-\\s]?factor|auth(?:entication)?\\s?code|verification\\s?code|pin(?:\\s?code|\\s?number)?|cvv|cvc|card\\s?(?:number|details)|login\\s?credentials|(?:recovery|backup|seed)\\s?(?:code|phrase|key|words?)";
const CRED_VERB =
  "send|share|give|provide|tell|forward|enter|submit|confirm|type|input|key\\s?in|paste";
const OUTPUT_CREDENTIAL: Array<{ re: RegExp; reason: string }> = [
  // imperative "<verb> … <secret>" (inbound verbs + output-only type/input/paste)
  {
    re: new RegExp(
      `\\b(?:${CRED_VERB})\\b[^.!?\\n]{0,40}\\b(?:${SECRET_NOUN})\\b`,
      "i",
    ),
    reason: "solicits a secret/credential",
  },
  // interrogative "what (is|'s|are) your … <secret>"
  {
    re: new RegExp(
      `\\bwhat(?:'s| is| are)?\\b[^.!?\\n]{0,15}\\byour\\b[^.!?\\n]{0,15}\\b(?:${SECRET_NOUN})\\b`,
      "i",
    ),
    reason: "solicits a secret/credential",
  },
];

/**
 * Validate an AI-generated reply. Returns every distinct (family, evidence)
 * violation found; `ok` is true only when there are none. Empty/whitespace text
 * is always ok (nothing to send anyway).
 */
export function validateOutput(
  text: string,
  context?: OutputValidationContext,
): OutputValidationResult {
  // Scan the ENTIRE reply — unlike inbound (which is hard-capped at ingress so its
  // scan window always covers the whole message), an outbound reply has no such
  // cap, so truncating here would let a leak in the tail slip past unscanned
  // (codex). All checks are linear (bounded negated classes), so full-scan is O(n).
  const t = text ?? "";
  const violations: OutputViolation[] = [];
  if (!t.trim()) return { ok: true, violations };

  for (const m of INTERNAL_MARKERS) {
    if (m.re.test(t))
      violations.push({ family: "leaked_internals", evidence: m.reason });
  }
  for (const p of PLAN_LEAKAGE) {
    if (p.re.test(t))
      violations.push({ family: "plan_leakage", evidence: p.reason });
  }
  for (const c of OUTPUT_CREDENTIAL) {
    if (c.re.test(t))
      violations.push({
        family: "credential_solicitation",
        evidence: c.reason,
      });
  }
  for (const r of detectUnsafeLinkHosts(t)) {
    violations.push({ family: "unsafe_link", evidence: r });
  }
  violations.push(...claimViolations(t, context));
  if (context?.priceContextLoaded === false && containsCurrencyAmount(t)) {
    violations.push({
      family: "invented_price",
      evidence:
        "reply asserts a price but no price-bearing context was loaded this run",
    });
  }

  // De-dupe identical (family, evidence) pairs so repeated markers in one reply
  // log once.
  const seen = new Set<string>();
  const deduped = violations.filter((v) => {
    const k = `${v.family}:${v.evidence}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { ok: deduped.length === 0, violations: deduped };
}

/** The honesty checks: a reply that says a Booking or a Request exists when the run recorded none. */
function claimViolations(t: string, context?: OutputValidationContext): OutputViolation[] {
  const violations: OutputViolation[] = [];
  const claimsBooking = context?.bookingRequestRecorded ? claimsBookingConfirmed(t) : claimsBookingDone(t);
  if (context?.bookingRecorded === false && claimsBooking) {
    violations.push({
      family: "fake_booking_confirmation",
      evidence:
        "reply claims a booking mutation but none was recorded this run",
    });
  }
  // A CONFIRMED BOOKING OUTRANKS A REQUEST, so it satisfies this claim too: the customer's
  // ask was not merely forwarded, it was fulfilled, and blocking "your request is in" on the
  // turn that booked them would replace a good reply with a fallback. Only a run that
  // recorded NEITHER can be lying here.
  if (
    context?.requestRecorded === false &&
    context.bookingRecorded === false &&
    claimsRequestForwarded(t)
  ) {
    violations.push({
      family: "fake_request_confirmation",
      evidence:
        "reply claims a request reached the business but none was recorded this run",
    });
  }
  return violations;
}
