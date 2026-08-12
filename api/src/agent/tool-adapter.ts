import type { DataSource } from 'typeorm';
import type { ChatMessage } from '../llm/llm.types';

export interface ToolContext {
  tenantId: string;
  sessionId: string;
  runId: string;
  toolsCalledThisTurn: string[];
  dataSource: DataSource;
  conversationHistory: ChatMessage[];
  /** SpecialtyCatalog S5: selected-specialty aliases/tags that bias KB retrieval
   *  (embedding only). Set by agent.service; absent ⇒ no bias. */
  specialtyTerms?: string[];
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** R31: set true ONLY for a tool-authored DOMAIN error that is safe to show the
   *  model (e.g. "no availability that day", "service not found"). An UNMARKED
   *  error is treated as a potentially-raw infrastructure exception and is
   *  sanitized to a generic message before it reaches the model — the raw text is
   *  kept in logs/trace only. Secure-by-default: omit ⇒ sanitized. */
  errorSafeForModel?: boolean;
  /**
   * Measurement that must NEVER reach the model.
   *
   * `data` is serialised straight into the tool message, and that message is truncated at 4000
   * characters - so a measurement blob on `data` does not merely waste tokens, it can cut the
   * payload the model actually needs. It would also put vocabulary like "preferred" and "cost"
   * in front of a model that is meant to be unaware any scoring happened (#81 is shadow).
   */
  measurement?: unknown;
  /**
   * A control the CLIENT should offer, which the model must never be told about.
   *
   * Same rule as `measurement` and for two reasons, one of which is new. `data` is serialised into
   * the tool message and truncated at 4000 characters, so anything parked there competes with the
   * payload the model actually needs. And a model told that a picker exists will start describing
   * it - "I've opened an address box for you" - which is a sentence about a UI it cannot see and
   * has no way to know appeared.
   *
   * This is how a server-observed affordance reaches the customer without passing through the
   * model, which is the same rule the whole address binding rests on: only the server may put a
   * control on screen, because only the server knows what it means.
   */
  affordance?: Affordance;
}

/**
 * Offer the customer the address-suggestion list.
 *
 * Raised when a job happens at the customer's address and no verified place is bound yet - the
 * only moment a picker changes anything, and the only one worth paying a billed request for.
 */
export interface AddressPickerAffordance {
  kind: 'address_picker';
  /**
   * Why it is being offered, which decides how insistent the client should be.
   *
   * `too_vague` is the consequential one: Google reached the town and no further, so NO time can
   * be auto-confirmed until a precise address exists. `unverified` is the ordinary case - things
   * work, they are just running on text nobody has checked.
   */
  reason: 'unverified' | 'too_vague';
  /**
   * What they already typed, to prefill the box.
   *
   * Their own address, travelling to their own browser - not the disclosure the "never log either
   * address" rule guards against. It must still never reach a log or the model.
   */
  query?: string;
}

export type Affordance = AddressPickerAffordance;

export interface ToolAdapter {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  hasSideEffects: boolean;
  preconditions?: { toolsCalled?: string[] };
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
