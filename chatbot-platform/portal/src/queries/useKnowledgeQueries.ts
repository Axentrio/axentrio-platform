import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// --- Query Options ---

export const knowledgeOptions = {
  base: () => queryOptions({
    queryKey: queryKeys.knowledge.base(),
    queryFn: () => api.get<Any>('/knowledge/base'),
  }),
  documents: () => queryOptions({
    queryKey: queryKeys.knowledge.documents(),
    queryFn: async () => {
      const res = await api.get<Any>('/knowledge/documents', { params: { limit: 100 } });
      return Array.isArray(res) ? res : res?.documents ?? [];
    },
  }),
  stats: () => queryOptions({
    queryKey: queryKeys.knowledge.stats(),
    queryFn: () => api.get<Any>('/knowledge/stats'),
  }),
};

// --- Query Hooks ---

export function useKnowledgeBase() {
  return useQuery(knowledgeOptions.base());
}

export function useKnowledgeDocuments() {
  return useQuery({
    ...knowledgeOptions.documents(),
    // Auto-poll every 5s while any document is pending/processing
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasProcessing = Array.isArray(data) &&
        data.some((d: Any) => d.status === 'pending' || d.status === 'processing');
      return hasProcessing ? 5000 : false;
    },
  });
}

export function useKnowledgeStats() {
  return useQuery(knowledgeOptions.stats());
}

// --- Mutations ---

export function useCreateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { type: string; title: string; sourceContent?: string; uploadToken?: string; metadata?: Record<string, Any> }) =>
      api.post('/knowledge/documents', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.documents() });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success('Document created');
    },
    onError: () => toast.error('Failed to create document'),
  });
}

export function useUpdateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { title?: string; sourceContent?: string; metadata?: Record<string, Any> } }) =>
      api.put(`/knowledge/documents/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.documents() });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success('Document updated');
    },
    onError: () => toast.error('Failed to update document'),
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/knowledge/documents/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.documents() });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success('Document deleted');
    },
    onError: () => toast.error('Failed to delete document'),
  });
}

export function useRetryDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/knowledge/documents/${id}/retry`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.documents() });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success('Document reprocessing started');
    },
    onError: () => toast.error('Failed to retry document'),
  });
}

export function useUploadFile() {
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      return api.post<{ uploadToken: string }>('/knowledge/documents/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    },
    onError: () => toast.error('File upload failed'),
  });
}

export function useUpdateAiSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, Any>) =>
      api.patch('/tenants/me/ai-settings', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.tenants.me(), 'ai-settings'] });
      toast.success('AI settings saved');
    },
    onError: () => toast.error('Failed to save AI settings'),
  });
}

export function useGetAiSettings() {
  return useQuery({
    queryKey: [...queryKeys.tenants.me(), 'ai-settings'] as const,
    queryFn: () => api.get<Any>('/tenants/me/ai-settings'),
  });
}

export function useTestAiSettings() {
  return useMutation({
    mutationFn: (data: { question: string; provider?: string; model?: string; apiKey?: string }) =>
      api.post<{ response: string; provider: string; model: string }>('/tenants/me/ai-settings/test', data),
    onError: () => toast.error('Test failed'),
  });
}

interface TestChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TestChatResponse {
  response: string;
  provider: string;
  model: string;
  confidence?: number;
  chunksUsed?: number;
}

export function useTestChat() {
  return useMutation({
    mutationFn: (data: { message: string; history: TestChatMessage[]; useKnowledgeBase: boolean }) =>
      api.post<TestChatResponse>('/tenants/me/ai-settings/test-chat', data),
  });
}
