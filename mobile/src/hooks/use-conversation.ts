import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@axentrio/api-client';

import { useApi } from '@/providers/api-provider';

/** Full conversation (status + messages) for the detail screen. */
export function useConversation(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.conversation(id),
    queryFn: () => api.getConversation(id),
    enabled: Boolean(id),
  });
}
