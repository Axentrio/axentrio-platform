import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export type LeadSource = 'channel' | 'tool' | 'booking' | 'manual' | 'import' | 'webhook';
export type LeadStatus = 'new' | 'archived';

export interface Lead {
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

/**
 * Infinite-scroll variant. Backed by the same `/leads` route — the
 * server returns `nextCursor: string | null` and the hook walks it.
 */
export function useLeadsInfinite() {
  return useInfiniteQuery({
    queryKey: queryKeys.leads.all(),
    queryFn: ({ pageParam }) => {
      const search = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : '';
      return api.get<LeadsPage>(`/leads${search}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/** Mark a lead handled (archived) or reopen it. Refreshes the inbox on success. */
export function useUpdateLeadStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: LeadStatus }) =>
      api.patch<{ id: string; status: LeadStatus }>(`/leads/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.leads.all() }),
  });
}
