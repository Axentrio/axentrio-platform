import { useQuery } from '@tanstack/react-query';
import { queryKeys, type ListSessionsParams } from '@axentrio/api-client';

import { useApi } from '@/providers/api-provider';

/** Agent inbox: list of conversation sessions. */
export function useSessions(params?: ListSessionsParams) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.sessions(params),
    queryFn: () => api.listSessions(params),
  });
}
