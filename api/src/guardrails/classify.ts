// Lightweight, PURE inbound-message classifier (no I/O, no LLM, no network).
//
// Runs before any expensive AI reasoning (R52 cost ordering). It is a cheap
// regex/heuristic pass, deliberately CONSERVATIVE: a real customer sharing their
// own URL, an address, or a short reply must score `clean`. Detection families:
// suspicious link (R16/R51), scam/phishing (R10/AC15), business solicitation
// (R17), and spam (R10/R19). See .scratch/plan-global-ai-guardrails.md §2.
//
// HARD RULE: URLs are only ever EXTRACTED as strings here. We never fetch,
// resolve, expand, or follow them.

import type { ClassifyResult, GuardrailCategory } from "./types";

/** A message scores as flagged only at/above this combined family score. */
export const FLAG_THRESHOLD = 0.6;

/** Hard cap on inbound message length, enforced at EVERY AI-scheduling ingress
 *  (chat route, widget HTTP, socket) so the scan window always covers the whole
 *  stored message — closes the "benign prefix + payload" classifier evasion. */
export const MAX_MESSAGE_CONTENT_CHARS = 8000;

/** classify scans at most this many chars (kept == the ingress cap). */
export const MAX_CLASSIFY_CHARS = MAX_MESSAGE_CONTENT_CHARS;

// Known URL-shortener / redirect hosts — a strong phishing/spam signal because
// they hide the real destination.
const SHORTENER_HOSTS = new Set([
  "bit.ly",
  "tinyurl.com",
  "goo.gl",
  "t.co",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "rb.gy",
  "tiny.cc",
  "t.ly",
  "bl.ink",
  "lnkd.in",
  "shor.by",
  "short.io",
]);

// URL path fragments that, combined with a link, smell like credential capture.
const CREDENTIAL_PATH_RE =
  /\/(login|signin|sign-in|verify|verification|secure|account|recover(y)?|reset|unlock|confirm|appeal|billing|wallet|connect)\b/i;

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"')]+)/gi;

interface Signal {
  re: RegExp;
  weight: number;
  reason: string;
}

// Credential / secret SOLICITATION — the single most dangerous family. The
// distinction that matters (codex review): a customer *mentioning* "I didn't get
// my verification code" or asking "what's your IBAN to pay you?" is benign. Only
// a message that *solicits a secret from the recipient*, or asks for a seed/
// recovery phrase, scores. We deliberately do NOT flag standalone "verification
// code" / "IBAN" / "bank details" — an IBAN is a payment detail, not a secret.
const CREDENTIAL_SIGNALS: Signal[] = [
  {
    re: /\b(send|share|give|provide|tell|forward|enter|submit|confirm)\b[^.!?\n]{0,40}\b(password|passcode|otp|one[-\s]?time\s?(pass)?code|2fa|two[-\s]?factor|auth(entication)?\s?code|verification\s?code|pin\s?(code|number)?|cvv|cvc|card\s?(number|details)|login\s?(credentials|details|password)|credentials)\b/i,
    weight: 0.7,
    reason: "solicits a secret/credential",
  },
  {
    re: /\b(recovery|backup|seed)\s?(code|phrase|key|words?)\b/i,
    weight: 0.7,
    reason: "recovery/seed phrase",
  },
];

// Fake platform-security / account-threat phishing.
const PHISHING_SIGNALS: Signal[] = [
  {
    re: /\b(your\s+(page|account|profile)\s+(will\s+be|has\s+been)\s+(deleted|suspended|disabled|removed|restricted|terminated))\b/i,
    weight: 0.55,
    reason: "fake account-deletion threat",
  },
  {
    re: /\b(copyright|intellectual\s+property)\s+(violation|infringement|complaint)\b/i,
    weight: 0.45,
    reason: "fake copyright complaint",
  },
  {
    re: /\b(unusual|suspicious)\s+(login|activity|sign[-\s]?in)\b/i,
    weight: 0.4,
    reason: "fake security alert",
  },
  {
    re: /\b(verify|confirm|validate)\s+(your\s+)?(identity|account|page|business|profile)\b/i,
    weight: 0.4,
    reason: "account-verification lure",
  },
  {
    re: /\b(meta|facebook|instagram|whatsapp)\s+(support|security|team|verification|business\s+integrity)\b/i,
    weight: 0.4,
    reason: "impersonates platform support",
  },
  {
    re: /\b(within|in)\s+\d+\s+(hours?|minutes?|days?)\b.{0,40}\b(or|otherwise|to\s+avoid)\b/i,
    weight: 0.3,
    reason: "urgency deadline",
  },
];

// Money/crypto/investment scams.
const SCAM_SIGNALS: Signal[] = [
  {
    re: /\b(crypto(currency)?|bitcoin|btc|ethereum|eth|usdt|forex|binary\s+options)\b/i,
    weight: 0.3,
    reason: "crypto/forex pitch",
  },
  {
    re: /\b(guaranteed?|risk[-\s]?free)\s+(returns?|profit|income|roi)\b/i,
    weight: 0.5,
    reason: "guaranteed-returns promise",
  },
  {
    re: /\b(double|triple|10x|100x)\s+(your\s+)?(money|investment|capital)\b/i,
    weight: 0.5,
    reason: "unrealistic returns",
  },
  {
    re: /\b(investment\s+(opportunity|platform|scheme)|earn\s+\$?\d+\s+(per|a)\s+(day|week))\b/i,
    weight: 0.4,
    reason: "investment scheme",
  },
  {
    re: /\b(claim\s+your|you('?| ha)ve\s+won|congratulations.{0,20}\b(winner|prize|reward|gift\s?card))\b/i,
    weight: 0.45,
    reason: "prize/giveaway scam",
  },
];

// Cold B2B solicitation — NOT a real customer lead.
const SOLICITATION_SIGNALS: Signal[] = [
  {
    re: /\b(we|i)\s+(offer|provide|speciali[sz]e\s+in|can\s+help\s+(you|your\s+business)\s+with)\b.{0,40}\b(seo|ads?|advertising|marketing|web\s?(site|design)|leads?|lead\s?gen(eration)?|social\s+media|app\s+development|automation|chatbots?)\b/i,
    weight: 0.5,
    reason: "agency service pitch",
  },
  {
    re: /\b(boost|increase|grow|double|skyrocket)\b.{0,30}\b(your\s+)?(sales|traffic|revenue|ranking|followers|leads|conversions?)\b/i,
    weight: 0.45,
    reason: "growth pitch",
  },
  {
    re: /\b(i\s+(came\s+across|found|noticed|stumbled\s+upon)\s+your\s+(business|page|website|profile))\b/i,
    weight: 0.35,
    reason: "cold-outreach opener",
  },
  {
    re: /\b(partnership\s+(opportunity|proposal)|collaborat(e|ion)\s+(opportunity|proposal)|rank\s+(higher|#?1)\s+on\s+google)\b/i,
    weight: 0.4,
    reason: "partnership/SEO solicitation",
  },
  {
    re: /\b(first\s+month\s+free|free\s+(trial|audit|consultation)\s+for\s+your\s+(business|website))\b/i,
    weight: 0.3,
    reason: "free-offer hook",
  },
];

// Obvious spam.
const SPAM_SIGNALS: Signal[] = [
  {
    re: /\b(viagra|cialis|porn|xxx|adult\s+(content|cam)|hot\s+singles|escort)\b/i,
    weight: 0.6,
    reason: "adult spam",
  },
  // Two separate weak signals — either alone stays clean; together they corroborate.
  {
    re: /\bfree\s+(gift|giveaway|iphone|money|robux|v[-\s]?bucks)\b/i,
    weight: 0.4,
    reason: "free-prize bait",
  },
  {
    re: /\bclick\s+(here|the\s+link)\s+to\s+(win|claim)\b/i,
    weight: 0.4,
    reason: "clickbait",
  },
  // Gambling: the bare term is WEAK — legit venues/clubs/events mention "poker
  // night" (codex review). Promo context corroborates it to a flag.
  {
    re: /\b(casino|gambling|betting|slots?|poker|sportsbook|sports\s?book)\b/i,
    weight: 0.3,
    reason: "gambling term",
  },
  // Promo context in EITHER order corroborates (codex review — order-independent).
  // Promo tokens are gambling-SPECIFIC so venue/event questions ("deposit for
  // poker night?", "sign up for the poker league") stay clean.
  {
    re: /\b(casino|gambling|betting|slots?|poker|sportsbook|sports\s?book)\b[^.!?\n]{0,40}\b(bonus|free\s?spins?|jackpot|win\s?big|payout|wager|deposit\s?bonus|no[-\s]?deposit)\b/i,
    weight: 0.4,
    reason: "gambling promo",
  },
  {
    re: /\b(bonus|free\s?spins?|jackpot|win\s?big|payout|wager|deposit\s?bonus|no[-\s]?deposit)\b[^.!?\n]{0,40}\b(casino|gambling|betting|slots?|poker|sportsbook|sports\s?book)\b/i,
    weight: 0.4,
    reason: "gambling promo",
  },
];

function scoreSignals(
  text: string,
  signals: Signal[],
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  for (const s of signals) {
    if (s.re.test(text)) {
      score += s.weight;
      reasons.push(s.reason);
    }
  }
  return { score: Math.min(score, 1), reasons };
}

const HUMAN_PHRASES = new Set([
  "are you a bot",
  "are you there",
  "anyone",
  "anyone online",
  "anyone there",
  "bot",
  "great",
  "hello",
  "hello test",
  "hey",
  "hi",
  "hmm",
  "is anyone there",
  "is this working",
  "lol",
  "no",
  "ok",
  "okk",
  "still there",
  "test",
  "thanks",
  "what can you do",
  "who are you",
  "why is nobody answering",
  "why no answer",
  "yes",
  "you there",
]);

const CUSTOMER_DETAIL_RE =
  /^(?:\+?[\d\s().-]{7,}|\d{1,6}\s+[A-Za-zÀ-ÿ'’-]+(?:\s+[A-Za-zÀ-ÿ'’-]+){0,3}\b(?:avenue|ave|boulevard|blvd|lane|ln|road|rd|street|st)\.?|.{0,60}\b(?:appointment|book(?:ing)?|reserve|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.{0,40}(?:\d|am\b|pm\b))$/iu;

// Bare risky hosts / IP literals WITHOUT a scheme or www prefix — URL_RE only
// matches `http(s)://` / `www.`, so `bit.ly/x` or `5.188.2.1/login` would
// otherwise dodge inspectLinks and be treated as human (review round 2).
const BARE_RISKY_HOST_RE =
  /\b(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|rb\.gy|tiny\.cc|t\.ly|bl\.ink|lnkd\.in|shor\.by|short\.io)\b|\b\d{1,3}(\.\d{1,3}){3}\b/iu;

const STREET_ADDRESS_RE =
  /^(?:\d{1,5}\s+[A-Za-zÀ-ÿ'’-]+(?:\s+[A-Za-zÀ-ÿ'’-]+){0,3}|[A-Za-zÀ-ÿ'’-]+(?:\s+[A-Za-zÀ-ÿ'’-]+){0,3}\s+\d{1,5})(?:[,\s]+\d{4,5})?$/u;

/**
 * Human-typical short messages reset loop detection instead of advancing it.
 * Pure and conservative: any content-risk signal wins before the short-message
 * fallback, even when that signal alone is below the classifier threshold.
 */
export function isHumanSignal(
  text: string,
  linkInfo?: LinkInspection,
): boolean {
  const t = (text ?? "").slice(0, MAX_CLASSIFY_CHARS).trim();
  if (!t) return false;

  const contentRiskSignals = [
    CREDENTIAL_SIGNALS,
    PHISHING_SIGNALS,
    SCAM_SIGNALS,
    SOLICITATION_SIGNALS,
    SPAM_SIGNALS,
  ];
  const inspectedLinks = linkInfo ?? inspectLinks(t);
  if (
    contentRiskSignals.some((signals) => signals.some(({ re }) => re.test(t)))
  )
    return false;
  if (classifyMessage(t, "widget", inspectedLinks).category !== "clean")
    return false;
  if (inspectedLinks.score > 0) return false;
  // Bare shortener / IP-literal host without scheme or www (see BARE_RISKY_HOST_RE).
  if (BARE_RISKY_HOST_RE.test(t)) return false;

  const normalized = t
    .toLowerCase()
    .replace(/[?!.,…]+$/u, "")
    .trim();
  const tokens = t.split(/\s+/);
  if (/^[\p{P}\p{S}\p{M}\s]+$/u.test(t)) return true;
  if (HUMAN_PHRASES.has(normalized)) return true;
  if (tokens.length <= 4 && /\?+\s*$/u.test(t)) return true;
  if (CUSTOMER_DETAIL_RE.test(t) || STREET_ADDRESS_RE.test(t)) return true;
  return tokens.length <= 2;
}

export interface LinkInspection {
  links: string[];
  score: number;
  reasons: string[];
}

/** Extract URLs (as strings only) and surface suspicious-link signals. */
export function inspectLinks(text: string): LinkInspection {
  const links = [
    ...(text ?? "").slice(0, MAX_CLASSIFY_CHARS).matchAll(URL_RE),
  ].map((m) => m[1]);
  let score = 0;
  const reasons: string[] = [];
  for (const raw of links) {
    let host = "";
    let pathAndQuery = "";
    try {
      // Case-insensitive scheme check — `URL_RE` matches `HTTP://` too, and a
      // case-sensitive `startsWith('http')` would mangle it into a bad URL
      // (codex review). Prepend https only when there's no scheme at all.
      const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
      const u = new URL(hasScheme ? raw : `https://${raw}`);
      host = u.hostname.replace(/^www\./, "").toLowerCase();
      pathAndQuery = u.pathname + u.search;
    } catch {
      // Unparseable URL-ish token is itself mildly suspicious.
      score += 0.2;
      reasons.push("malformed link");
      continue;
    }
    if (SHORTENER_HOSTS.has(host)) {
      score += 0.5;
      reasons.push(`shortened link (${host})`);
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      score += 0.5;
      reasons.push("ip-literal link host");
    }
    if (host.includes("xn--")) {
      score += 0.4;
      reasons.push("punycode link host");
    }
    if (CREDENTIAL_PATH_RE.test(pathAndQuery)) {
      score += 0.4;
      reasons.push("credential-capture link path");
    }
  }
  // A single normal link to a normal domain contributes nothing → stays clean.
  return { links, score: Math.min(score, 1), reasons };
}

/**
 * Classify a single inbound message. Pure: same input → same output, no I/O.
 * Returns the highest-severity family at/above FLAG_THRESHOLD, else `clean`.
 * `channel` is accepted for future channel-aware weighting; today it only
 * nudges cold-outreach sensitivity on social DMs.
 */
export function classifyMessage(
  text: string,
  channel: string,
  inspectedLinks?: LinkInspection,
): ClassifyResult {
  const t = (text ?? "").slice(0, MAX_CLASSIFY_CHARS).trim();
  const linkInfo = inspectedLinks ?? inspectLinks(t);
  if (!t) {
    return { category: "clean", score: 0, reasons: [], links: linkInfo.links };
  }

  const credential = scoreSignals(t, CREDENTIAL_SIGNALS);
  const phishing = scoreSignals(t, PHISHING_SIGNALS);
  const scam = scoreSignals(t, SCAM_SIGNALS);
  const solicitation = scoreSignals(t, SOLICITATION_SIGNALS);
  const spam = scoreSignals(t, SPAM_SIGNALS);

  // A suspicious link alongside phishing/credential language reinforces both.
  const linkBoost = linkInfo.score > 0 ? 0.2 : 0;

  // Social DMs see more cold B2B outreach; nudge solicitation slightly.
  const isSocial = channel === "messenger" || channel === "instagram";
  const solicitationScore = Math.min(
    solicitation.score + (isSocial && solicitation.score > 0 ? 0.1 : 0),
    1,
  );

  // Phishing family = fake-security + credential asks + a credential-capture link.
  const phishingBoosted =
    (credential.score > 0 || phishing.score > 0) && linkBoost > 0;
  const phishingScore = Math.min(
    phishing.score + credential.score + (phishingBoosted ? linkBoost : 0),
    1,
  );
  // Surface the link evidence when it contributed to the flag (codex review).
  const phishingReasons = [
    ...phishing.reasons,
    ...credential.reasons,
    ...(phishingBoosted ? linkInfo.reasons : []),
  ];

  const scamBoosted = scam.score > 0 && linkBoost > 0;
  const scamScore = Math.min(scam.score + (scamBoosted ? linkBoost : 0), 1);
  const scamReasons = [
    ...scam.reasons,
    ...(scamBoosted ? linkInfo.reasons : []),
  ];
  const linkScore = linkInfo.score;

  // Severity-ordered candidates (most dangerous first wins ties).
  const candidates: Array<{
    category: GuardrailCategory;
    score: number;
    reasons: string[];
  }> = [
    { category: "phishing", score: phishingScore, reasons: phishingReasons },
    { category: "scam", score: scamScore, reasons: scamReasons },
    {
      category: "suspicious_link",
      score: linkScore,
      reasons: linkInfo.reasons,
    },
    {
      category: "solicitation",
      score: solicitationScore,
      reasons: solicitation.reasons,
    },
    { category: "spam", score: spam.score, reasons: spam.reasons },
  ];

  // Compare in integer basis points so float artefacts (0.7+0.2 = 0.8999…) can't
  // flip a tie. Candidates are severity-ordered, and strict `>` keeps the more
  // dangerous category on an equal score (codex review).
  const bp = (n: number) => Math.round(n * 100);
  let best = candidates[0];
  for (const c of candidates) {
    if (bp(c.score) > bp(best.score)) best = c;
  }

  if (bp(best.score) >= bp(FLAG_THRESHOLD)) {
    return {
      category: best.category,
      score: Math.min(best.score, 1),
      reasons: best.reasons,
      links: linkInfo.links,
    };
  }
  return { category: "clean", score: 0, reasons: [], links: linkInfo.links };
}

// ---------------------------------------------------------------------------
// Output-side link primitive, reusing this module's URL extraction + shortener
// set (guardrails output validation, AC14). Credential solicitation is handled
// separately in output-validation.ts with an OUTPUT-specific noun list (the
// inbound CREDENTIAL_SIGNALS deliberately differ — e.g. bare "credentials").
// ---------------------------------------------------------------------------

/**
 * Output-side link check: reasons a reply contains a link that HIDES or SPOOFS
 * its destination — shortener, IP-literal host, or punycode. These are never
 * legitimate in a bot reply. Deliberately OMITS the inbound credential-path
 * heuristic: a business may legitimately link its own /login or /account page,
 * so a path alone must not replace an otherwise-good reply (the credential
 * *text* is caught separately in output-validation.ts).
 */
export function detectUnsafeLinkHosts(text: string): string[] {
  const reasons: string[] = [];
  // Full scan (output has no ingress cap; linear) — see validateOutput.
  for (const m of (text ?? "").matchAll(URL_RE)) {
    let host = "";
    try {
      const raw = m[1];
      const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
      host = new URL(hasScheme ? raw : `https://${raw}`).hostname
        .replace(/^www\./, "")
        .toLowerCase();
    } catch {
      continue; // an unparseable URL-ish token alone is too weak to block a reply
    }
    if (SHORTENER_HOSTS.has(host)) reasons.push(`shortened link (${host})`);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host))
      reasons.push("ip-literal link host");
    if (host.includes("xn--")) reasons.push("punycode link host");
  }
  return reasons;
}
