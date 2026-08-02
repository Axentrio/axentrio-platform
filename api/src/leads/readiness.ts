/**
 * Lead readiness — how ACTIONABLE a lead is, scored deterministically.
 *
 * Story 3 asks Enterprise for a "lead quality score". This is deliberately not that,
 * for two reasons that survived review:
 *
 *  1. **Not an LLM number.** An opaque score attached to a named person is unexplainable,
 *     unstable across model versions, and indefensible when the owner disagrees with it.
 *     Every point here comes from a fact the operator can see on the row.
 *  2. **Not "quality".** The platform can defend "we have their phone, address and a
 *     booking". It cannot defend telling a business their customer is low quality — and
 *     under GDPR a scored judgement about a person invites an Art 22 / profiling
 *     argument this feature does not need. "Readiness" describes OUR record, not them.
 *
 * Consequences that are enforced elsewhere and must stay true:
 *   - it is NEVER the default sort and NEVER a filter that hides a lead
 *   - it triggers nothing automatically
 *   - a human override always wins and is terminal
 *
 * Computed on READ from the row already being projected — so it cannot go stale after a
 * booking is cancelled or a contact detail is added, which a persisted score would.
 */

export const READINESS_VERSION = 1;

export interface ReadinessComponent {
  key: string;
  /** Points contributed. Always positive; absence simply scores nothing. */
  points: number;
  /** Shown to the operator as the reason. */
  label: string;
}

export interface LeadReadiness {
  score: number; // 0..100
  version: number;
  source: 'computed' | 'human';
  components: ReadinessComponent[];
}

/** Inputs — all facts already on the projected lead row. Nothing inferred. */
export interface ReadinessInput {
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  notes?: string | null;
  address?: string | null;
  bookingId?: string | null;
  bookingStatus?: string | null;
  /**
   * Conversations this PERSON has had, not this lead ROW.
   *
   * The distinction is the whole of repeat detection: leads are one row per identity,
   * so a returning customer who arrived on WhatsApp and came back through the widget
   * owns two rows with one conversation each, and a per-row count calls neither of
   * them returning. The caller passes the repeat sweep's `person_conversation_count`,
   * falling back to the row's own count until the sweep has run — the row count is a
   * strict floor (a person's rows include this one), never a competing answer.
   */
  personConversationCount?: number | null;
  /** Operator-set override; when present it IS the score. */
  override?: number | null;
}

/**
 * Weights. Chosen so the two things an SMB actually needs to act — a way to reach them,
 * and knowing what they want — dominate, and so no single soft signal can carry a lead
 * to a high score on its own.
 */
const WEIGHTS = {
  reachable: 30, // phone OR email — without this the lead is not actionable at all
  bothChannels: 5, // having both is marginally better, not twice as good
  request: 25, // we know what they want
  booking: 25, // they committed to a time
  address: 10, // on-site trades cannot dispatch without it
  named: 5, // a name makes the callback human
  returning: 5, // more than one conversation
} as const;

/**
 * Score a lead 0..100.
 *
 * A cancelled/failed booking scores NOTHING for the booking component — counting it
 * would rank a lead that walked away above one still deciding.
 */
export function computeLeadReadiness(lead: ReadinessInput): LeadReadiness {
  if (typeof lead.override === 'number' && Number.isFinite(lead.override)) {
    const clamped = Math.max(0, Math.min(100, Math.round(lead.override)));
    return {
      score: clamped,
      version: READINESS_VERSION,
      source: 'human',
      components: [{ key: 'human_override', points: clamped, label: 'Set manually' }],
    };
  }

  const components: ReadinessComponent[] = [];
  const add = (key: string, points: number, label: string) => components.push({ key, points, label });

  const hasPhone = !!lead.phone;
  const hasEmail = !!lead.email;
  if (hasPhone || hasEmail) {
    add('reachable', WEIGHTS.reachable, hasPhone ? 'Phone number' : 'Email address');
    if (hasPhone && hasEmail) add('both_channels', WEIGHTS.bothChannels, 'Phone and email');
  }
  if (lead.notes && lead.notes.trim()) add('request', WEIGHTS.request, 'Told us what they need');

  const bookingLive =
    !!lead.bookingId && lead.bookingStatus !== 'cancelled' && lead.bookingStatus !== 'failed';
  if (bookingLive) add('booking', WEIGHTS.booking, 'Has a booking');

  if (lead.address && lead.address.trim()) add('address', WEIGHTS.address, 'Address known');
  if (lead.name && lead.name.trim()) add('named', WEIGHTS.named, 'Gave their name');
  if ((lead.personConversationCount ?? 0) > 1) add('returning', WEIGHTS.returning, 'Returning contact');

  const score = Math.min(100, components.reduce((n, c) => n + c.points, 0));
  return { score, version: READINESS_VERSION, source: 'computed', components };
}

/**
 * Coarse band for display. Bands, not a bare number, because a two-point difference
 * between leads is noise and showing "68 vs 66" invites false precision.
 */
export function readinessBand(score: number): 'ready' | 'partial' | 'thin' {
  if (score >= 70) return 'ready';
  if (score >= 40) return 'partial';
  return 'thin';
}
