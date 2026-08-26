import type { DataSource } from 'typeorm';
import type { ChatMessage } from '../llm/llm.types';
import type { ChannelType } from '../database/entities/ChannelConnection';

export interface ToolContext {
  tenantId: string;
  sessionId: string;
  runId: string;
  /** The surface receiving controls. Unknown channels fail closed. */
  channel: ChannelType;
  toolsCalledThisTurn: string[];
  dataSource: DataSource;
  conversationHistory: ChatMessage[];
  /** SpecialtyCatalog S5: selected-specialty aliases/tags that bias KB retrieval
   *  (embedding only). Set by agent.service; absent ⇒ no bias. */
  specialtyTerms?: string[];
  /** False when a human already owns the session. Absent = treat as bot-owned. */
  botOwned?: boolean;
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
  /**
   * Authoritative fact the final reply must state. It is harvested by AgentService, never
   * serialised into the model-facing tool payload, response metadata, or persisted trace.
   */
  replyFact?: ReplyFact;
  /**
   * The offered slots as INSTANTS, for the server's own use: the slot chips, the offer record,
   * and the guard that catches a reply naming a time nobody offered.
   *
   * Same rule as `measurement` and `affordance`, for a reason this file has now paid for twice.
   * `data` is what the MODEL reads, and a model handed a UTC instant reads its digits as a wall
   * clock: on 2026-08-26 a Brussels bot answered "the next valid time is 08:30" from a
   * `2026-10-09T08:30:00.000Z` slot whose local time was 10:30, above chips that said 10:30.
   * So `data.slots` speaks the business's local wall clock, with no offset to misread, and the
   * instants the server needs travel here instead of being derived back out of local strings.
   */
  availability?: {
    /** ISO UTC, exactly as the provider emitted them. */
    slots: Array<{ start: string; end: string }>;
    /**
     * Travel times the owner MIGHT reach, offered in prose and captured with
     * request_appointment.
     *
     * They carry no chip, so nothing else on this object mentions them - but the guard that
     * replaces a reply naming an unofferable time must count them as offered. Without them, a
     * mixed result turns the one sentence the tool asked for ("14:00 is further away, shall I
     * ask the business?") into "that time is not available".
     */
    requestableSlots?: Array<{ start: string; end: string }>;
    timezone: string;
    serviceId?: string;
    serviceName?: string;
    locationMode?: string;
    travel?: {
      groupingPilot?: boolean;
      grouped?: { savedMinutes: number };
      groupingPreviousOrder?: string[];
    };
  };
}

export interface BookingAddressReplyFact {
  kind: 'booking_address';
  address: string;
  use: 'availability' | 'confirmed_booking' | 'request';
  /** Other known addresses that this reply must not present as the one actually used. */
  alternatives: string[];
}

export type ReplyFact = BookingAddressReplyFact;

/**
 * One offered address suggestion.
 *
 * `id` and `placeId` are the durable EVIDENCE that this option was really offered: `offeredPlaceId`
 * reads them back from the persisted reply to prove a tapped button was one the server issued.
 * `text` is the Google Places display string. ADR-0014 is default-deny on caching Google Maps
 * Content, and a suggestion the customer never chose backs no record, so `text` is DELIVERY-ONLY:
 * it reaches the provider message body via `renderChannelAddressControls` and must never be
 * persisted. `storedAffordance` drops it on the way to `messages.metadata` and the socket frame.
 */
export interface OfferedAddressOption {
  /** Opaque short id returned by the channel button. */
  id: string;
  /** Server-held identity resolved only after the persisted option is tapped. */
  placeId: string;
  /** Full address rendered in the message body. Delivery-only; never persisted (ADR-0014). */
  text: string;
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
  /** Native-channel choices, produced by the server and never by the model. */
  options?: OfferedAddressOption[];
}

/**
 * Ask which of two addresses is right, and let the answer be a server-observed event.
 *
 * The whole of #95. `address-binding.ts` opens by refusing to let a tool argument move the
 * binding, because a model can report agreement after silence or after an explicit rejection -
 * provenance is not agreement. A typed "yes" is the same claim in the customer's voice, arriving
 * through the model, and it is why the customer's answer has never changed anything.
 *
 * So the SERVER states both options and issues the id, and the answer comes back through an
 * endpoint rather than through a sentence. The model may introduce the question; it may not define
 * the choices.
 */
export interface AddressConfirmAffordance {
  kind: 'address_confirm';
  /** Which question is being answered. A late "yes" must not settle one already left behind. */
  proposalId: string;
  /** The address something suggested instead. */
  proposed: string;
  /** The address the customer actually chose, which stands unless they say otherwise. */
  bound: string;
}

export type Affordance = AddressPickerAffordance | AddressConfirmAffordance;

/**
 * The shape allowed to persist and cross the wire: the evidence, without the Google display string.
 *
 * ADR-0014 forbids caching Google Maps Content, and `text` on an offered suggestion is exactly
 * that. `messages.metadata` and the socket frame therefore carry the picker options as `{id,
 * placeId}` only. The customer still sees the full addresses, because the provider message body is
 * built from the in-memory `Affordance` (which keeps `text`), not from this stored form.
 */
export type StoredAffordance =
  | (Omit<AddressPickerAffordance, 'options'> & { options?: Array<Pick<OfferedAddressOption, 'id' | 'placeId'>> })
  | AddressConfirmAffordance;

/**
 * Map an in-memory affordance to its persisted/wire form, dropping the delivery-only suggestion
 * text. Returns a NEW object and never mutates the input, because the caller renders the provider
 * message from the original `text`-bearing affordance immediately afterwards.
 */
export function storedAffordance(a: Affordance): StoredAffordance {
  if (a.kind !== 'address_picker' || !a.options) return a;
  return { ...a, options: a.options.map(({ id, placeId }) => ({ id, placeId })) };
}

export interface ToolAdapter {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  hasSideEffects: boolean;
  preconditions?: { toolsCalled?: string[] };
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
