// Global AI Workflow Guardrails — shared types.
//
// One vocabulary used by the classifier, the loop detector, the persisted
// `chat_sessions.guardrail_status` column, and the inbound gate. See
// .scratch/plan-global-ai-guardrails.md §1/§2 for the design.

/** A single, consistent classification vocabulary. 'clean' maps to the DB
 *  `guardrail_status='normal'`; every other value is stored verbatim. */
export type GuardrailCategory =
  | 'clean'
  | 'spam'
  | 'scam'
  | 'phishing'
  | 'solicitation'
  | 'bot_loop'
  | 'suspicious_link';

/** What the inbound gate decided to do with this message.
 *  `block_neutral` is intentionally absent in Slice 1 (no_reply only). */
export type GuardrailAction = 'proceed' | 'block_silent' | 'over_budget';

export interface GuardrailDecision {
  action: GuardrailAction;
  category: GuardrailCategory;
  /** 0..1 strength of the flag (0 for a clean `proceed`). */
  score: number;
  reasons: string[];
  /** Raw URLs extracted from the message — never fetched/followed (R16/R51). */
  suspiciousLinks: string[];
  /** Whether the session's `ai_auto_reply_enabled` should be flipped off. */
  disableAutoReply: boolean;
}

/** Result of the pure content classifier (no session state, no I/O). */
export interface ClassifyResult {
  category: GuardrailCategory;
  score: number;
  reasons: string[];
  links: string[];
}
