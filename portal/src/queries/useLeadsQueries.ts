import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export type LeadSource = 'channel' | 'tool' | 'booking' | 'manual' | 'import' | 'webhook';
/** `erased` is terminal and excluded from every list — never observed here in practice. */
export type LeadStatus = 'new' | 'archived' | 'erased';
export type LeadPriceBasis = 'fixed' | 'from' | 'range_mid' | 'none';

/**
 * Structured (Pro) fields, returned only when the tenant is entitled to
 * `leadEnrichment`. Optional on the type because the server OMITS them entirely
 * rather than nulling them — so `lead.address !== undefined` means "entitled and
 * known", `null` means "entitled, nothing recorded", absent means "not entitled".
 *
 * Every value is derived server-side from the lead's most recent non-cancelled
 * booking. None of it is model-generated.
 */
export interface LeadStructuredFields {
  bookingId: string | null;
  bookingStatus: string | null;
  preferredAt: string | null;
  address: string | null;
  serviceRequested: string | null;
  /** The tenant's OWN list price for the service — a fact, not an estimate. */
  servicePrice: number | null;
  priceBasis: LeadPriceBasis;
  /**
   * Already joined to their question LABELS by the API — same shape the bookings surface
   * uses. It was a uuid-keyed map, which the drawer printed verbatim, so an owner read
   * "a3f2c1d0-…: Second floor" instead of "Which floor?: Second floor".
   */
  intakeAnswers: Array<{ label: string; answer: string }> | null;
  /** >1 means the booking shown is not the only one for this contact. */
  bookingCount: number;
  /**
   * Conversations on THIS record. Deliberately NOT a repeat signal: a customer who
   * arrived on WhatsApp and came back through the widget owns two records with one
   * conversation each. Use `isRepeatCustomer` for anything that says "returning".
   */
  conversationCount: number;

  // ── Repeat-customer detection (server-side nightly sweep) ──────────────────
  /** Conversations by this PERSON, across every record we hold for them. */
  personConversationCount: number;
  /** Live records we hold for the same person — >1 is the merge suggestion. */
  personLeadCount: number;
  personFirstSeenAt: string | null;
  personLastSeenAt: string | null;
  /** The one server-side definition of "returning", so the UI cannot invent another. */
  isRepeatCustomer: boolean;
}

/**
 * The Enterprise recommended follow-up action (`aiBusinessInsights`).
 *
 * Derived server-side from the lead's own facts — no model call, so it cannot invent an
 * obligation and a visitor cannot steer it by typing. Every recommendation carries the
 * reasons that fired it.
 *
 * Advisory only: there is no worklist, so nothing here can be actioned, dismissed or
 * marked done, and the portal must not pretend otherwise.
 */
export type FollowUpAction =
  | 'confirm_request'
  | 'win_back_cancelled'
  | 'check_in_after_visit'
  | 'offer_a_time'
  | 'ask_what_they_need';

export type FollowUpVia = 'phone' | 'channel' | 'email';
export type FollowUpPriority = 'now' | 'soon';

export interface FollowUpReason {
  key: string;
  /** English text from the server, used as the i18n `defaultValue` for `key`. */
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

export interface Lead extends Partial<LeadStructuredFields> {
  id: string;
  sessionId: string | null;
  botId: string | null;
  /** Null when the channel never provided one (Meta/Telegram users hide names). */
  name: string | null;
  /** Null for channel leads — social platforms never provide email. */
  email: string | null;
  phone: string | null;
  /** Channel of origin (widget/whatsapp/messenger/instagram/telegram), null for legacy. */
  channel: string | null;
  source: LeadSource;
  /** Worklist state — operator marks a handled lead 'archived'. */
  status: LeadStatus;
  notes: string | null;
  createdAt: string;
  /**
   * When anyone last had contact — the server's own definition (`person_last_seen_at`
   * falling back to the record's `updated_at`), not when the row was created. Drives
   * the "waiting" column, and is the same number the follow-up recommendation cites.
   */
  lastActivityAt: string | null;
  /**
   * Absent when the tenant is not entitled to `aiBusinessInsights` — which is what
   * keeps the panel off an unentitled tenant's screen without a second gate here.
   * `null` when entitled and there is nothing worth suggesting.
   */
  followUp?: FollowUpRecommendation | null;
}

export interface LeadsPage {
  leads: Lead[];
  nextCursor: string | null;
}

/** Server-side filters. Applied in SQL, so counts reflect the whole dataset. */
export interface LeadFilters {
  status?: 'new' | 'archived';
  channel?: string;
  source?: LeadSource;
}

function toSearch(filters: LeadFilters, cursor: string | null): string {
  const q = new URLSearchParams();
  if (cursor) q.set('cursor', cursor);
  if (filters.status) q.set('status', filters.status);
  if (filters.channel) q.set('channel', filters.channel);
  if (filters.source) q.set('source', filters.source);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Infinite-scroll variant. Backed by the same `/leads` route — the server returns
 * `nextCursor: string | null` and the hook walks it.
 *
 * `filters` is part of the query KEY: without it, a filtered and an unfiltered page
 * would share one cache entry and the list would show stale rows after a filter change.
 */
export function useLeadsInfinite(filters: LeadFilters = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.leads.list(filters),
    queryFn: ({ pageParam }) => api.get<LeadsPage>(`/leads${toSearch(filters, pageParam)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/** Mark a lead handled (archived) or reopen it. Refreshes the inbox on success. */
export function useUpdateLeadStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'new' | 'archived' }) =>
      api.patch<{ id: string; status: LeadStatus }>(`/leads/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.leads.all() }),
  });
}

export interface LeadErasureResult {
  id: string;
  erased: true;
  scrubbed: { conversations: number; notifications: number; webhookLogs: number };
  transcriptRetained: boolean;
}

/**
 * Erase a lead's personal data (GDPR Art 17). Irreversible: the row is kept as an
 * auditable husk with every personal field stripped, derived copies are scrubbed, and
 * a `lead.deleted` event is emitted so a connected CRM can delete its own copy.
 */
export function useEraseLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<LeadErasureResult>(`/leads/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.leads.all() }),
  });
}

export interface LeadSyncAttempt {
  event: string;
  status: string;
  httpStatus: number | null;
  attempt: number;
  /** Host only — the full URL can carry a secret token in its path. */
  host: string;
  error: string | null;
  at: string;
}

export interface LeadSyncStatus {
  /** Whether the tenant has any outbound endpoint at all. */
  configured: boolean;
  /** 'not_configured' | 'never_sent' | the latest delivery status. */
  status: string;
  lastAttemptAt: string | null;
  attempts: LeadSyncAttempt[];
}

/**
 * Per-lead CRM delivery status, fetched ON DEMAND when a row is expanded.
 *
 * Deliberately not part of the list payload: most tenants have no webhooks, and joining
 * delivery history into every page would make all of them pay for a question only some
 * of them ask.
 */
export function useLeadSyncStatus(leadId: string | null) {
  return useQuery({
    queryKey: [...queryKeys.leads.all(), 'sync', leadId] as const,
    queryFn: () => api.get<LeadSyncStatus>(`/leads/${leadId}/sync`),
    enabled: !!leadId,
    staleTime: 30_000,
  });
}
