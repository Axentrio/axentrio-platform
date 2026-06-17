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
// cannot drift. Checks the plan names but does NOT attempt (not reliably
// detectable from output text alone): invented price, fake confirmation, fake
// feature-unlock, inferred-tier — those need backend/state cross-checks.

import { detectUnsafeLinkHosts, MAX_CLASSIFY_CHARS } from './classify';

export type OutputViolationFamily =
  | 'leaked_internals'
  | 'plan_leakage'
  | 'credential_solicitation'
  | 'unsafe_link';

export interface OutputViolation {
  family: OutputViolationFamily;
  evidence: string;
}

export interface OutputValidationResult {
  ok: boolean;
  violations: OutputViolation[];
}

// Internal markers that have NO legitimate place in a reply to a customer.
// The fence markers + section headers mirror compose-system-prompt.ts exactly,
// so a leak of the assembled system prompt is caught verbatim; the tool/id/
// secret patterns are infrastructure details a reply must never expose.
const INTERNAL_MARKERS: Array<{ re: RegExp; reason: string }> = [
  // Prompt fences (unique to our composer — impossible in an organic reply).
  { re: /<<<\s*(?:KNOWLEDGE|EXTRA_INFO)\b|\b(?:KNOWLEDGE|EXTRA_INFO)\s*>>>/i, reason: 'prompt fence marker' },
  // Distinctive composed section headers (mirror compose-system-prompt.ts).
  { re: /##\s*PLATFORM RULES \(non-negotiable\)/i, reason: 'platform-rules header' },
  { re: /##\s*KNOWLEDGE BASE \(reference data/i, reason: 'knowledge-base section header' },
  { re: /##\s*ADDITIONAL CONTEXT \(reference only/i, reason: 'additional-context header' },
  { re: /##\s*GUARDRAILS\b/i, reason: 'guardrails header' },
  { re: /##\s*FORMATTING RULES \(CRITICAL/i, reason: 'formatting-rules header' },
  { re: /\bLANGUAGE \(read first\):/i, reason: 'language-directive header' },
  // Internal tool names.
  { re: /\b(?:kb_search|capture_lead|escalate_to_human)\b/, reason: 'internal tool name' },
  // Internal id field names (snake_case ids that only exist server-side).
  { re: /\b(?:tenant_id|session_id|bot_id|conversation_id)\b/, reason: 'internal id field' },
  // Secret / API-key shapes (high-precision — these strings are always secrets).
  // OpenAI keys include sk-proj-/sk-svcacct-/sk-admin- prefixes (codex).
  { re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9]{16,}\b/, reason: 'openai-style secret key' },
  { re: /\bsk_(?:live|test|prod)_[A-Za-z0-9]{8,}\b/i, reason: 'stripe-style secret key' },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, reason: 'jwt token' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/, reason: 'bearer token' },
  // Internal automation infrastructure.
  { re: /\bwebhookUrl\b|\bn8n\.(?:io|com|cloud)\b/i, reason: 'internal webhook/automation reference' },
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
const PLAN = 'Essential|Pro|Enterprise';
const PLAN_NAME = `(?:${PLAN})\\s+(?:plan|tier|subscription)`;
const PLAN_LEAKAGE: Array<{ re: RegExp; reason: string }> = [
  { re: new RegExp(`\\bfeature\\b[^.!?\\n]{0,40}\\b${PLAN_NAME}\\b`, 'i'), reason: 'gates a feature behind a plan' },
  { re: new RegExp(`\\b${PLAN_NAME}\\b[^.!?\\n]{0,40}\\bfeature\\b`, 'i'), reason: 'gates a feature behind a plan' },
  { re: new RegExp(`\\b(?:not (?:available|included|supported)|only (?:available|included|on)|available only on|require[sd]?|need(?:s|ed)?)\\b[^.!?\\n]{0,30}\\b${PLAN_NAME}\\b`, 'i'), reason: 'gates a feature behind a plan' },
  { re: new RegExp(`\\b${PLAN_NAME}\\b[^.!?\\n]{0,30}\\bto (?:use|access|enable|unlock)\\b`, 'i'), reason: 'gates a feature behind a plan' },
];

// Output credential solicitation — fully self-contained (does NOT reuse the
// inbound helper, which still matches bare "credentials" = professional
// qualifications, e.g. "provide your credentials as a therapist"; codex). Same
// "solicits a secret, not merely mentions one" bar as inbound, but over a
// narrowed OUTPUT noun list: bare "credentials" dropped (only "login
// credentials" is a secret), and "password" excludes policy/help phrasings
// ("password reset/policy"). Contact details (name/email/phone) are never here.
const SECRET_NOUN =
  'password(?!\\s+(?:reset|policy|requirement|protection|manager))|passcode|otp|one[-\\s]?time\\s?(?:pass)?code|2fa|two[-\\s]?factor|auth(?:entication)?\\s?code|verification\\s?code|pin(?:\\s?code|\\s?number)?|cvv|cvc|card\\s?(?:number|details)|login\\s?credentials|(?:recovery|backup|seed)\\s?(?:code|phrase|key|words?)';
const CRED_VERB = 'send|share|give|provide|tell|forward|enter|submit|confirm|type|input|key\\s?in|paste';
const OUTPUT_CREDENTIAL: Array<{ re: RegExp; reason: string }> = [
  // imperative "<verb> … <secret>" (inbound verbs + output-only type/input/paste)
  { re: new RegExp(`\\b(?:${CRED_VERB})\\b[^.!?\\n]{0,40}\\b(?:${SECRET_NOUN})\\b`, 'i'), reason: 'solicits a secret/credential' },
  // interrogative "what (is|'s|are) your … <secret>"
  { re: new RegExp(`\\bwhat(?:'s| is| are)?\\b[^.!?\\n]{0,15}\\byour\\b[^.!?\\n]{0,15}\\b(?:${SECRET_NOUN})\\b`, 'i'), reason: 'solicits a secret/credential' },
];

/**
 * Validate an AI-generated reply. Returns every distinct (family, evidence)
 * violation found; `ok` is true only when there are none. Empty/whitespace text
 * is always ok (nothing to send anyway).
 */
export function validateOutput(text: string): OutputValidationResult {
  const t = (text ?? '').slice(0, MAX_CLASSIFY_CHARS);
  const violations: OutputViolation[] = [];
  if (!t.trim()) return { ok: true, violations };

  for (const m of INTERNAL_MARKERS) {
    if (m.re.test(t)) violations.push({ family: 'leaked_internals', evidence: m.reason });
  }
  for (const p of PLAN_LEAKAGE) {
    if (p.re.test(t)) violations.push({ family: 'plan_leakage', evidence: p.reason });
  }
  for (const c of OUTPUT_CREDENTIAL) {
    if (c.re.test(t)) violations.push({ family: 'credential_solicitation', evidence: c.reason });
  }
  for (const r of detectUnsafeLinkHosts(t)) {
    violations.push({ family: 'unsafe_link', evidence: r });
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
