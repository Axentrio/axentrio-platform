import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export type LeadSource = 'channel' | 'tool' | 'booking' | 'manual' | 'import' | 'webhook';

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
