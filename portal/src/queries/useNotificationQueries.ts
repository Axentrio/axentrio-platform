import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const notificationOptions = {
  list: () => queryOptions({
    queryKey: queryKeys.notifications.list(),
    queryFn: () => api.get<Any>('/notifications'),
  }),
};

export function useNotifications() {
  return useQuery(notificationOptions.list());
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch(`/notifications/${id}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.patch('/notifications/read-all'),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.notifications.all() });
      const previous = queryClient.getQueryData(queryKeys.notifications.list());
      queryClient.setQueryData(queryKeys.notifications.list(), (old: Any) =>
        Array.isArray(old) ? old.map((n: Record<string, unknown>) => ({ ...n, read: true })) : old
      );
      return { previous };
    },
    onError: (_err: unknown, _vars: unknown, context: { previous?: unknown } | undefined) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.notifications.list(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() });
    },
  });
}
