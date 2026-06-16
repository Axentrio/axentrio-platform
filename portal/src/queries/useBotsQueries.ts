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

export type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export interface BusinessHours {
  enabled: boolean;
  timezone: string;
  schedule: Array<{ day: WeekDay; open: string; close: string; closed: boolean }>;
}

export interface BotDetail extends BotListItem {
  embedSnippet: string;
  businessHours: BusinessHours | null;
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
  detail: (botId: string) =>
    queryOptions({
      queryKey: queryKeys.bots.detail(botId),
      queryFn: () => api.get<BotDetail>(`/bots/${botId}`),
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

export function useBotDetail(botId: string | null | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery({
    ...botsOptions.detail(botId ?? ''),
    enabled: !!botId && (opts.enabled ?? true),
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
    mutationFn: ({ id, ...patch }: { id: string; name?: string; status?: BotStatus; businessHours?: BusinessHours }) =>
      api.patch<BotListItem>(`/bots/${id}`, patch),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bots.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.bots.detail(vars.id) });
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

// --- Per-bot template binding (bot-templates Phase 4) ---

export interface BotTemplateOption {
  id: string;
  key: string;
  displayName: string;
  category: string | null;
  description: string | null;
  availableToAllTenants: boolean;
  latestPublishedVersion: number | null;
}

export type TemplateMode = 'and' | 'or';

export interface BoundTemplate {
  templateId: string;
  version: string;
  publishedVersions: number[];
  resolvedVersion: number | null;
  pinnedButUnavailable: boolean;
  templateUnavailable: boolean;
}

export interface BotTemplateView {
  available: BotTemplateOption[];
  mode: TemplateMode;
  bindings: BoundTemplate[];
  missingModules: string[];
  // Back-compat (primary binding) — older callers.
  binding: { templateId: string | null; templateVersion: string };
  resolved: { resolvedVersion: number | null; body: string; pinnedButUnavailable: boolean; templateUnavailable: boolean };
  publishedVersions: number[];
}

/** GET /bots/:id/templates — picker options + current binding + resolved preview. */
export function useBotTemplates(botId: string, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.bots.templates(botId),
    queryFn: () => api.get<BotTemplateView>(`/bots/${botId}/templates`),
    enabled: !!botId && (opts.enabled ?? true),
  });
}

/** PUT /bots/:id/template — set the bot's template bindings (up to 3) + AND/OR mode. */
export function useBindBotTemplate(botId: string) {
  const queryClient = useQueryClient();
  const key = queryKeys.bots.templates(botId);
  return useMutation({
    mutationFn: (input: { bindings: { templateId: string; version: string }[]; mode: TemplateMode }) =>
      api.put<BotTemplateView>(`/bots/${botId}/template`, input),
    // Reflect the new chips + AND/OR mode immediately so the UI feels instant,
    // then reconcile with the server's authoritative view — no extra refetch.
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<BotTemplateView>(key);
      if (prev) {
        const bindings: BoundTemplate[] = input.bindings.map((b) => {
          const existing = prev.bindings.find((x) => x.templateId === b.templateId);
          return existing
            ? { ...existing, version: b.version }
            : {
                templateId: b.templateId,
                version: b.version,
                publishedVersions: [],
                resolvedVersion: null,
                pinnedButUnavailable: false,
                templateUnavailable: false,
              };
        });
        queryClient.setQueryData<BotTemplateView>(key, { ...prev, bindings, mode: input.mode });
      }
      return { prev };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
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

// --- Per-bot knowledge (dedicated vs shared org KB) ---

export interface BotKnowledgeDocument {
  id: string;
  title: string;
  type: string;
  status: 'pending' | 'processing' | 'indexed' | 'failed';
  createdAt: string;
}

export interface BotKnowledgeState {
  mode: 'shared' | 'dedicated';
  kbId: string | null;
  documents: BotKnowledgeDocument[];
}

export function useBotKnowledge(botId: string | null | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.bots.knowledge(botId ?? ''),
    queryFn: () => api.get<BotKnowledgeState>(`/bots/${botId}/knowledge`),
    enabled: !!botId && (opts.enabled ?? true),
  });
}

export function useEnableDedicatedKb(botId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/bots/${botId}/knowledge/dedicated`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bots.knowledge(botId) }),
  });
}

export function useDisableDedicatedKb(botId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/bots/${botId}/knowledge/dedicated`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bots.knowledge(botId) }),
  });
}

export function useAddBotDocument(botId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      type: 'text' | 'faq' | 'pdf' | 'docx';
      title: string;
      sourceContent?: string;
      uploadToken?: string;
    }) => api.post(`/bots/${botId}/documents`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bots.knowledge(botId) }),
  });
}

export function useDeleteBotDocument(botId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => api.delete(`/bots/${botId}/documents/${docId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bots.knowledge(botId) }),
  });
}
