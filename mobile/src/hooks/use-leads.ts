import { useInfiniteQuery } from '@tanstack/react-query';
import { queryKeys } from '@axentrio/api-client';

import { useApi } from '@/providers/api-provider';

/** Cursor-paginated leads. */
export function useLeads() {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: queryKeys.leads,
    queryFn: ({ pageParam }) => api.listLeads({ cursor: pageParam, limit: 25 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
