/**
 * Pro's "proactive lead capture" (Story 3): may the bot ask this customer, on this
 * turn, for a way to reach them?
 *
 * The spec's hard rule is that it must never feel pushy — "part of the service
 * experience, not a forced questionnaire". That is a property of the WORDING (measured
 * by the committed eval in ./eval) and of the FREQUENCY, which is what this decides.
 *
 * This replaces a deterministic two-chip offer that shipped and could never fire: on a
 * channel it was suppressed by design, and on the widget it required a successful
 * `capture_lead`, which itself requires an email or phone — so it needed the contact
 * details it existed to obtain. That pincer is why the gate below keys off the
 * CONVERSATION rather than off a captured lead.
 *
 * Every condition is a restraint, and each one is load-bearing:
 *
 *  - `enabled` — the tenant opted in. `proactiveLeadCapture` is in OPT_IN_FEATURES, so
 *    absent means OFF: being entitled to it is not the same as having asked for it.
 *    This changes what the bot says to an EU consumer, so it is an explicit act.
 *  - `!isChannel` — on WhatsApp/Messenger/Instagram/Telegram we can already reply to
 *    them forever. Asking for a phone number there is pure friction with no payoff.
 *  - `!hasContact` — never ask for something we already have. A customer who typed
 *    their email and is then asked for it reads the bot as not listening.
 *  - `customerTurns >= 2` — never on the opening turn. "Hi" → "what's your number?" is
 *    precisely the forced questionnaire the spec forbids.
 *  - `!askedAt` — at most ONCE per conversation, ever. Marked when the instruction is
 *    put in front of the model, not when the model demonstrably asks: erring toward
 *    asking too rarely is the safe direction, and it makes the guarantee structural
 *    rather than a sentence in a prompt the model may drift from.
 */
import type { AskState } from './ask-state';

export interface AskInput {
  /** EFFECTIVE `proactiveLeadCapture` — entitled AND switched on by the tenant. */
  enabled: boolean;
  /** True for a messaging channel; false for the website widget. */
  isChannel: boolean;
  /** Do we already have an email or phone for this conversation? */
  hasContact: boolean;
  /** Customer turns so far in this conversation. */
  customerTurns: number;
  state: AskState;
}

export function shouldAskForContact(input: AskInput): boolean {
  if (!input.enabled) return false;
  if (input.isChannel) return false;
  if (input.hasContact) return false;
  if (input.customerTurns < 2) return false;
  return !input.state.askedAt;
}

/**
 * The instruction handed to the model. Deliberately phrased as a CEILING on behaviour
 * rather than an objective: every clause tells it what not to do, because the failure
 * mode being guarded is enthusiasm.
 *
 * "Once" is repeated here even though `shouldAskForContact` already guarantees it
 * structurally — within a single turn the model could otherwise ask twice in one reply.
 *
 * Changing this string invalidates the eval. Re-run `npm run eval:proactive` and update
 * the published numbers in ./eval/fixtures.ts before shipping a reword.
 */
export const PROACTIVE_ASK_RULE =
  `\n## OFFERING TO FOLLOW UP\nThis customer has described what they need but has given no email or phone number. ONCE in this conversation — and only after you have actually answered what they asked — you may add a single short sentence offering to have someone follow up, and asking whether they would like to leave an email or phone number.\nRules, all non-negotiable:\n- Answer their question FIRST. The offer is an addition to a helpful reply, never a replacement for one and never the whole message.\n- Ask at most ONE time, in ONE sentence. Never repeat it later in this conversation.\n- If they say no, decline, ignore it, or change the subject, accept that silently and never raise it again. Do not rephrase it as a different question.\n- Never make it a condition of helping them, and never imply you cannot continue without it.\n- Never ask for an address, a company name, or anything beyond an email or phone number.\n- If they do give you an email or phone number, call the capture_lead tool in that same turn.`;
