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
  intakeAnswers: Record<string, unknown> | null;
  /** >1 means the booking shown is not the only one for this contact. */
  bookingCount: number;
  conversationCount: number;
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
