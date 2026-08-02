/**
 * Wire contract for the Leads API.
 *
 * This file had drifted badly from the route: it declared `name`/`email` as
 * required strings when both are nullable (a WhatsApp lead has neither — it is
 * identified by its channel handle), and omitted `channel`, `status` and the
 * `channel`/`booking` sources entirely. Anything typed against it was being told
 * a shape the server never sends.
 */

/**
 * How the lead was captured. `channel` (inbound messaging hook) and `booking`
 * (booking hook) produce most real leads and were missing here.
 */
export type LeadSource = 'channel' | 'tool' | 'booking' | 'manual' | 'import' | 'webhook';

/**
 * Worklist state. `erased` is terminal and set only by the erasure path; erased
 * leads are excluded from every list, so clients will not normally observe it.
 */
export type LeadStatus = 'new' | 'archived' | 'erased';

/** How a `servicePrice` was derived, so the UI can label it honestly. */
export type LeadPriceBasis = 'fixed' | 'from' | 'range_mid' | 'none';

/**
 * The structured fields returned ONLY to tenants entitled to `leadEnrichment`.
 * Every one is DERIVED at read time from the lead's most recent non-cancelled
 * booking — never copied onto the lead, because a copy would go stale the moment
 * the booking is rescheduled or cancelled. Absent (not null) when unentitled, so
 * `'address' in lead` distinguishes "not entitled" from "no address known".
 */
export interface LeadStructuredFields {
  bookingId: string | null;
  bookingStatus: string | null;
  /** Appointment start (or requested time) in ISO-8601. */
  preferredAt: string | null;
  address: string | null;
  serviceRequested: string | null;
  /**
   * The TENANT's own list price for the requested service — a fact from their
   * service catalogue, not an AI estimate. `null` when the service is priced
   * "on request" or has no price set.
   */
  servicePrice: number | null;
  priceBasis: LeadPriceBasis;
  /** Customer answers to the owner-authored booking intake questions. */
  intakeAnswers: Record<string, unknown> | null;
  /** Total bookings for this lead — >1 means the shown one is not the only one. */
  bookingCount: number;
  /**
   * Conversations on THIS record. Deliberately not a repeat signal: leads are one
   * row per identity, so a customer who arrived on WhatsApp and came back through
   * the widget has two records with one conversation each. Use
   * `personConversationCount` for anything that says "returning".
   */
  conversationCount: number;

  /**
   * Repeat-customer detection. Computed by a nightly pass that groups a tenant's
   * live leads on an exact normalised phone (E.164) or email match — never on a
   * name, and never transitively. Until that pass has seen a record, the person
   * fields fall back to this record alone, so they under-report rather than
   * inventing a repeat.
   *
   * The grouping key itself is NOT on the wire: it is a plaintext phone or email,
   * and the UI needs the counts, not the identifier.
   */
  personConversationCount: number;
  /** Live records this platform holds for the same person — the merge suggestion. */
  personLeadCount: number;
  /** ISO-8601. First time this PERSON appeared, across all their records. */
  personFirstSeenAt: string | null;
  /** ISO-8601. Most recent conversation by this person, across all their records. */
  personLastSeenAt: string | null;
  /** The one server-side definition of "returning", so clients cannot invent another. */
  isRepeatCustomer: boolean;
}

/**
 * The recommended follow-up action, returned ONLY to tenants entitled to
 * `aiBusinessInsights` (Enterprise) — the same gate the lead-demand panel uses.
 *
 * Derived deterministically from the lead's own facts, never model-generated: see
 * api/src/leads/followup.ts for the rules and for why `urgency`/`intent`/`tags` are
 * excluded from them. Advisory only — there is no worklist, so it cannot be actioned,
 * dismissed or marked done, and nothing about it is stored.
 */
export type FollowUpAction =
  | 'confirm_request'
  | 'win_back_cancelled'
  | 'check_in_after_visit'
  | 'offer_a_time'
  | 'ask_what_they_need';

/** The route to use: phone, the channel thread they wrote from, or email. */
export type FollowUpVia = 'phone' | 'channel' | 'email';

export type FollowUpPriority = 'now' | 'soon';

/** Why the recommendation fired. Every recommendation carries at least one. */
export interface FollowUpReason {
  key: string;
  /** English text; clients use it as the i18n fallback for `key`. */
  label: string;
  /** Set only on quantified reasons (`waiting`). */
  days?: number;
}

export interface FollowUpRecommendation {
  action: FollowUpAction;
  via: FollowUpVia;
  priority: FollowUpPriority;
  reasons: FollowUpReason[];
  version: number;
}

/** Item in GET /api/v1/leads */
export interface Lead extends Partial<LeadStructuredFields> {
  id: string;
  sessionId?: string | null;
  botId?: string | null;
  /** Nullable: a channel lead may be identified only by its handle. */
  name: string | null;
  email: string | null;
  phone?: string | null;
  /** widget | whatsapp | messenger | instagram | telegram. */
  channel: string | null;
  source: LeadSource;
  status: LeadStatus;
  /** The captured request / conversation summary. */
  notes: string | null;
  createdAt: string;
  /**
   * Absent when the tenant is not entitled to `aiBusinessInsights`; `null` when they
   * are and there is nothing worth suggesting (no way to reach them, already handled,
   * or an appointment still ahead of them).
   */
  followUp?: FollowUpRecommendation | null;
}

/** GET /api/v1/leads (cursor-paginated). */
export interface LeadsPage {
  leads: Lead[];
  nextCursor?: string | null;
}

/** Query params for GET /api/v1/leads. All filters are server-side. */
export interface LeadsQuery {
  limit?: number;
  cursor?: string;
  status?: 'new' | 'archived';
  channel?: string;
  source?: LeadSource;
}

/** Response of DELETE /api/v1/leads/:id (erasure). */
export interface LeadErasureResult {
  id: string;
  erased: true;
  scrubbed: { conversations: number; notifications: number; webhookLogs: number };
  /**
   * True: the chat transcript is a SEPARATE deletion scope and was not removed.
   * Surfaced so callers don't assume erasure covered everything.
   */
  transcriptRetained: boolean;
}
