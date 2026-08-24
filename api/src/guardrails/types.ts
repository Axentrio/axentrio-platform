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

/** Categories that exist only in the durable guardrail journal. */
export type GuardrailJournalCategory =
  | GuardrailCategory
  | 'missing_tenant'
  | 'missing_bot';

/** Result of the pure content classifier (no session state, no I/O). */
export interface ClassifyResult {
  category: GuardrailCategory;
  score: number;
  reasons: string[];
  links: string[];
}
