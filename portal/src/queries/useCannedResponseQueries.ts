import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export interface CannedResponse {
  id: string;
  tenantId: string;
  createdByUserId?: string;
  title: string;
  shortcut: string;
  content: string;
  category?: string;
  tags: string[];
  scope: 'shared' | 'personal';
  usageCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CreateCannedResponseInput {
  title: string;
  shortcut: string;
  content: string;
  category?: string;
  tags?: string[];
  scope: 'shared' | 'personal';
}

interface UpdateCannedResponseInput {
  title?: string;
  shortcut?: string;
  content?: string;
  category?: string | null;
  tags?: string[];
}

interface UseCannedResponseResult {
  content: string;
  usageCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const cannedResponseOptions = {
  list: (filters?: Record<string, unknown>) => queryOptions({
    queryKey: queryKeys.cannedResponses.list(filters),
    queryFn: () => api.get<Any>('/canned-responses', { params: filters }),
  }),
  detail: (id: string) => queryOptions({
    queryKey: queryKeys.cannedResponses.detail(id),
    queryFn: () => api.get<CannedResponse>(`/canned-responses/${id}`),
    enabled: !!id,
  }),
};

export function useCannedResponses(filters?: Record<string, unknown>) {
  return useQuery(cannedResponseOptions.list(filters));
}

export function useCreateCannedResponse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCannedResponseInput) =>
      api.post('/canned-responses', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cannedResponses.all() });
    },
  });
}

export function useUpdateCannedResponse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateCannedResponseInput) =>
      api.patch(`/canned-responses/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cannedResponses.all() });
    },
  });
}

export function useDeleteCannedResponse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/canned-responses/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cannedResponses.all() });
    },
  });
}

export function useUseCannedResponse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, variables }: { id: string; variables?: Record<string, string> }) =>
      api.post<UseCannedResponseResult>(`/canned-responses/${id}/use`, { variables }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cannedResponses.all() });
    },
  });
}
