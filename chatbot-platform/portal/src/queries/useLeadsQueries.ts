import { useQuery, useInfiniteQuery, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export type LeadSource = 'tool' | 'manual' | 'import' | 'webhook';

export interface Lead {
  id: string;
  sessionId: string | null;
  botId: string | null;
  name: string;
  email: string;
  phone: string | null;
  source: LeadSource;
  notes: string | null;
  createdAt: string;
}

export interface LeadsPage {
  leads: Lead[];
  nextCursor: string | null;
}

/**
 * Single-page query — used by the Leads page initial render. For
 * pagination beyond the first page use `useLeadsInfinite` below.
 */
export const leadsOptions = {
  list: (cursor?: string | null) =>
    queryOptions({
      queryKey: queryKeys.leads.list(cursor),
      queryFn: () => {
        const search = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        return api.get<LeadsPage>(`/leads${search}`);
      },
    }),
};

export function useLeads(cursor?: string | null) {
  return useQuery(leadsOptions.list(cursor));
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
