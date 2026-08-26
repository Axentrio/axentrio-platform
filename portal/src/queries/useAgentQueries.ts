import { useQuery, useMutation, useQueryClient, queryOptions, type QueryKey } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const agentOptions = {
  list: (filters?: Record<string, unknown>) => queryOptions({
    queryKey: queryKeys.agents.list(filters),
    // GET /agents answers the paginated shape { agents: [...], meta } (the
    // apiClient already stripped the success envelope). Unwrap HERE so every
    // consumer gets a plain array — the Inbox mapped the raw object and its
    // Transfer modal crashed on .map; Team fell through to an empty list.
    // Older deploys answered a bare array — accept both.
    queryFn: async () => {
      const payload = await api.get<{ agents?: Any[] } | Any[]>('/agents', { params: filters });
      return Array.isArray(payload) ? payload : (payload.agents ?? []);
    },
  }),
  detail: (id: string) => queryOptions({
    queryKey: queryKeys.agents.detail(id),
    queryFn: () => api.get<Any>(`/agents/${id}`),
    enabled: !!id,
  }),
  shifts: (id: string) => queryOptions({
    queryKey: queryKeys.agents.shifts(id),
    queryFn: () => api.get<Any>(`/agents/${id}/shifts`),
    enabled: !!id,
  }),
  performance: (id: string) => queryOptions({
    queryKey: queryKeys.agents.performance(id),
    queryFn: () => api.get<Any>(`/agents/${id}/performance`),
    enabled: !!id,
  }),
};

export function useAgentList(filters?: Record<string, unknown>) {
  return useQuery(agentOptions.list(filters));
}

export function useAgentShifts(id: string) {
  return useQuery(agentOptions.shifts(id));
}

export function useUpdateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) =>
      api.patch(`/agents/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.all() });
    },
  });
}

// --- Optimistic Mutations ---

export function useOptimisticUpdateAgentStatus(queryKey: QueryKey) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/agents/${id}/status`, { status }),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey });
      const previousData = queryClient.getQueryData<Any[]>(queryKey);
      queryClient.setQueryData<Any[]>(queryKey, (prev = []) =>
        prev.map((a: Any) => (a.id === id ? { ...a, status } : a)),
      );
      return { previousData };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKey, context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.all() });
    },
  });
}
