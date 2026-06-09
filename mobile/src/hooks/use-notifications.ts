import { useQuery } from '@tanstack/react-query';
import { queryKeys, type ListNotificationsParams } from '@axentrio/api-client';

import { useApi } from '@/providers/api-provider';

export function useNotifications(params?: ListNotificationsParams) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.notifications(params),
    queryFn: () => api.listNotifications(params),
  });
}
