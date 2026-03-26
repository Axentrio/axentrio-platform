import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const agentOptions = {
  list: (filters?: Record<string, unknown>) => queryOptions({
    queryKey: queryKeys.agents.list(filters),
    queryFn: () => api.get<Any[]>('/agents', { params: filters }),
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

export function useAgentDetail(id: string) {
  return useQuery(agentOptions.detail(id));
}

export function useAgentShifts(id: string) {
  return useQuery(agentOptions.shifts(id));
}

export function useAgentPerformance(id: string) {
  return useQuery(agentOptions.performance(id));
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

// Optimistic update pattern: consumers can use mutation.variables.status + mutation.isPending
// for UI-based optimistic rendering
export function useUpdateAgentStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/agents/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.all() });
    },
  });
}

export function useCreateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => api.post('/agents', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.all() });
    },
  });
}
