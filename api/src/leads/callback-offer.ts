/**
 * The Pro "proactive lead capture" behaviour — deliberately NOT the AI asking.
 *
 * Story 3 wants Pro to collect missing contact details, "but always in a natural and
 * friendly way… never a forced form". Review landed on a deterministic offer instead of
 * a prompt-level ask, for three reasons:
 *
 *  1. **"Never pushy" becomes structural, not aspirational.** The bot's own words are
 *     unchanged; we append a two-chip offer. There is no wording that can drift, no
 *     temperature, and nothing to re-measure when the model is upgraded. The eval harness
 *     that validated the existing capture wording was never committed and its result is
 *     not reproducible, so an LLM-level ask cannot honestly be called "not pushy" today.
 *  2. **A tap is a real consent signal.** "Yes, call me back" is an explicit, storable
 *     act. An LLM coaxing a phone number out of someone is not.
 *  3. **Declines are enforceable.** "No thanks" is persisted, and this module then never
 *     offers again for that conversation — a prompt rule cannot make that guarantee.
 *
 * Chips carry a `value` that the widget sends back as an ordinary text message, so the
 * decline has to be recognised server-side on the next inbound turn — see
 * `detectCallbackReply`. Without that, the chip would store nothing.
 *
 * Everything here is gated on the tenant's `proactiveLeadCapture` toggle, which is
 * opt-in (absent preference = OFF) precisely because it changes what personal data the
 * bot asks an EU consumer for.
 */
import type { ChatSession } from '../database/entities/ChatSession';

export interface QuickReply {
  title: string;
  value: string;
}

/**
 * Reserved sentinels. Matched exactly on the way back in, so a customer typing
 * "no thanks" in conversation is NOT mistaken for tapping the decline chip — only the
 * chip's own payload counts as an explicit answer.
 */
export const CALLBACK_ACCEPT_VALUE = '__lead_callback_yes__';
export const CALLBACK_DECLINE_VALUE = '__lead_callback_no__';

/** Ask-state, persisted on the session so it survives restarts and re-entry. */
export interface CallbackOfferState {
  offeredAt?: string;
  acceptedAt?: string;
  declinedAt?: string;
}

export function readOfferState(session: Pick<ChatSession, 'metadata'>): CallbackOfferState {
  const raw = (session.metadata as { leadCallback?: unknown } | null)?.leadCallback;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as CallbackOfferState) : {};
}

export interface OfferInput {
  /** Effective `proactiveLeadCapture` — entitled AND switched on by the tenant. */
  enabled: boolean;
  /** Do we already have a way to reach them off-channel? */
  hasContact: boolean;
  /** True once `capture_lead` has fired with a request summary this session. */
  requestCaptured: boolean;
  /** Customer turns so far. */
  customerTurns: number;
  state: CallbackOfferState;
  /** Localised chip labels. */
  labels: { yes: string; no: string };
}

/**
 * Decide whether to append the offer. Every condition is a deliberate restraint:
 *
 *  - `enabled` — tenant opted in.
 *  - `!hasContact` — never ask for something we already have.
 *  - `requestCaptured` — only offer once the customer has actually described a need.
 *    An offer attached to "what time do you close?" is exactly the forced-questionnaire
 *    feel Story 3 forbids.
 *  - `customerTurns >= 2` — never on the opening turn.
 *  - no prior offer/accept/decline — asked at most ONCE per conversation, ever.
 */
export function shouldOfferCallback(input: OfferInput): boolean {
  if (!input.enabled) return false;
  if (input.hasContact) return false;
  if (!input.requestCaptured) return false;
  if (input.customerTurns < 2) return false;
  const { offeredAt, acceptedAt, declinedAt } = input.state;
  return !offeredAt && !acceptedAt && !declinedAt;
}

/** The two chips. Titles are localised; values are the reserved sentinels. */
export function buildCallbackQuickReplies(labels: { yes: string; no: string }): QuickReply[] {
  return [
    { title: labels.yes, value: CALLBACK_ACCEPT_VALUE },
    { title: labels.no, value: CALLBACK_DECLINE_VALUE },
  ];
}

export type CallbackReply = 'accepted' | 'declined' | null;

/**
 * Recognise a chip tap on the next inbound message. Exact match only — a customer who
 * types "no thanks" in the middle of a sentence has not answered the offer, and treating
 * that as a decline would silently suppress a legitimate later one.
 */
export function detectCallbackReply(content: string): CallbackReply {
  const trimmed = content.trim();
  if (trimmed === CALLBACK_ACCEPT_VALUE) return 'accepted';
  if (trimmed === CALLBACK_DECLINE_VALUE) return 'declined';
  return null;
}

/**
 * The customer-visible text a tap should be replaced with before it reaches the model or
 * the transcript. The raw sentinel must never be shown, logged as customer speech, or
 * fed to the extractor as if the customer typed it.
 */
export function humanizeCallbackReply(reply: Exclude<CallbackReply, null>, labels: { yes: string; no: string }): string {
  return reply === 'accepted' ? labels.yes : labels.no;
}

/** Merge new ask-state into the session metadata without disturbing other keys. */
export function withOfferState(
  metadata: Record<string, unknown> | null | undefined,
  patch: CallbackOfferState,
): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  const prior = readOfferState({ metadata: base } as Pick<ChatSession, 'metadata'>);
  return { ...base, leadCallback: { ...prior, ...patch } };
}
