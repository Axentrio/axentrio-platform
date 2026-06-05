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
  /** The bot's AI-enabled state (for the onboarding checklist on the list). */
  aiEnabled: boolean;
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

// --- Per-bot AI settings + test chat (multi-bot config editing) ---

export interface BotTestChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BotTestChatResponse {
  response: string;
  provider: string;
  model: string;
  confidence?: number;
  chunksUsed?: number;
}

/** GET /bots/:id/ai-settings — always returns a full editable AI shape. */
export function useBotAiSettings(botId: string | null | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.bots.aiSettings(botId ?? ''),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: () => api.get<any>(`/bots/${botId}/ai-settings`),
    enabled: !!botId && (opts.enabled ?? true),
  });
}

/** PUT /bots/:id/ai-settings — full-replace of the bot's behavioural AI config. */
export function useUpdateBotAiSettings(botId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mutationFn: (data: any) => api.put<any>(`/bots/${botId}/ai-settings`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bots.aiSettings(botId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.bots.list() });
    },
  });
}

/** POST /bots/:id/test-chat — preview against this bot's config + attached KBs. */
export function useBotTestChat(botId: string) {
  return useMutation({
    mutationFn: (data: { message: string; history: BotTestChatMessage[]; useKnowledgeBase: boolean }) =>
      api.post<BotTestChatResponse>(`/bots/${botId}/test-chat`, data),
  });
}
