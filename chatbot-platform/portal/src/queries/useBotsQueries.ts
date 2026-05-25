/**
 * useBotsQueries
 * React Query SDK for the multi-bot (Phase 2) endpoints.
 *
 * Backend: `GET/POST/PATCH/DELETE /api/v1/bots` and
 *          `GET /api/v1/bots/:id/embed`.
 *
 * The 402-with-`plan_limit_bots` flow lives upstream in the apiClient
 * interceptor (it already toasts a generic upgrade nudge). Mutations here
 * surface the structured `error.code` to callers so the create/activate
 * dialogs can render an inline UpgradeCTA in addition to the toast.
 */

import axios from 'axios';
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export type BotStatus = 'active' | 'paused';

export interface BotListItem {
  id: string;
  name: string;
  status: BotStatus;
  isDefault: boolean;
  publicKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface BotsListResponse {
  bots: BotListItem[];
  used: number;
  limit: number | null;
}

export interface BotEmbedResponse {
  snippet: string;
  publicKey?: string;
}

/**
 * Extracts the structured backend error code from an Axios error response.
 * Backend bodies follow `{ error: { code, message, ... } }`.
 */
export function extractApiErrorCode(err: unknown): string | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const body = err.response?.data as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}

// --- Query options ---

export const botsOptions = {
  list: () =>
    queryOptions({
      queryKey: queryKeys.bots.list(),
      queryFn: () => api.get<BotsListResponse>('/bots'),
      staleTime: FIVE_MINUTES_MS,
    }),
  embed: (botId: string) =>
    queryOptions({
      queryKey: queryKeys.bots.embed(botId),
      queryFn: () => api.get<BotEmbedResponse>(`/bots/${botId}/embed`),
      enabled: !!botId,
    }),
};

// --- Queries ---

export function useBots() {
  return useQuery(botsOptions.list());
}

export function useBotEmbed(botId: string | null | undefined) {
  return useQuery({
    ...botsOptions.embed(botId ?? ''),
    enabled: !!botId,
  });
}

// --- Mutations ---

export function useCreateBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => api.post<BotListItem>('/bots', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bots.list() });
    },
  });
}

export function useUpdateBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; status?: BotStatus }) =>
      api.patch<BotListItem>(`/bots/${id}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bots.list() });
    },
  });
}

export function useDeleteBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/bots/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bots.list() });
    },
  });
}
