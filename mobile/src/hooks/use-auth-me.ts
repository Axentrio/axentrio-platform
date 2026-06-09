import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@axentrio/api-client';

import { useApi } from '@/providers/api-provider';

/** Current operator + active-org identity from GET /auth/me. */
export function useAuthMe() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.authMe,
    queryFn: () => api.authMe(),
  });
}
