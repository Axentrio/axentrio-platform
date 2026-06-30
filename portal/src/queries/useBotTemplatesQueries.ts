import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

export type TemplateStatus = 'active' | 'archived';
export type VersionStatus = 'draft' | 'published' | 'unpublished';

export interface BotTemplateSummary {
  id: string;
  key: string;
  displayName: string;
  category: string | null;
  description: string | null;
  availableToAllTenants: boolean;
  status: TemplateStatus;
  versionCount: number;
  draftCount: number;
  latestPublishedVersion: number | null;
}

export interface BotTemplate {
  id: string;
  key: string;
  displayName: string;
  category: string | null;
  description: string | null;
  availableToAllTenants: boolean;
  status: TemplateStatus;
  createdAt: string;
  updatedAt: string;
}

/** Template-owned tone + policy guardrails, versioned with the body (admin-controlled). */
export interface BotTemplateConfig {
  tone?: string;
  guardrails?: {
    topicsToAvoid?: string[];
    greetingMessage?: string;
    fallbackMessage?: string;
    offHoursMessage?: string;
    confidenceThreshold?: number;
    maxResponseLength?: number;
  };
}

export interface BotTemplateVersion {
  id: string;
  templateId: string;
  version: number;
  body: string;
  changelog: string | null;
  expectedModules: string[];
  /** Composable-templates: super-admin-selected module refs (authoritative when
   *  present; falls back to expectedModules when null). Pinned at publish time. */
  selectedModuleRefs?: { moduleId: string; moduleVersion: number }[] | null;
  config: BotTemplateConfig;
  status: VersionStatus;
  publishedAt: string | null;
  publishedBy: string | null;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface BotTemplateDetail {
  template: BotTemplate;
  versions: BotTemplateVersion[];
  grantedTenantIds: string[];
  usage: { bots: number; tenants: number };
  moduleCatalog: { id: string; displayName: string }[];
}

/** Reads the block-or-force conflict details off a 409 response, if present. */
export function forceConflict(
  error: unknown,
): { impactedBots?: number; impactedTenants?: Array<{ tenantId: string; bots: number }> } | null {
  if (!(error instanceof AxiosError) || error.response?.status !== 409) return null;
  const details = (error.response.data as { error?: { details?: Record<string, unknown> } })?.error?.details;
  if (!details) return null;
  const out: { impactedBots?: number; impactedTenants?: Array<{ tenantId: string; bots: number }> } = {};
  if (typeof details.impactedBots === 'number') out.impactedBots = details.impactedBots;
  if (Array.isArray(details.impactedTenants)) out.impactedTenants = details.impactedTenants as never;
  return Object.keys(out).length ? out : null;
}

/** onError that defers 409 force-conflicts to the caller and toasts everything else. */
function toastUnlessForceConflict(error: unknown): void {
  if (forceConflict(error)) return; // caller handles the confirm-then-force flow
  toast.error(extractApiErrorMessage(error) ?? 'Something went wrong');
}

const options = {
  list: () =>
    queryOptions({
      queryKey: queryKeys.admin.botTemplates(),
      queryFn: async () => {
        const res = await api.get<{ templates: BotTemplateSummary[] }>('/admin/bot-templates');
        return res.templates;
      },
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: queryKeys.admin.botTemplateDetail(id),
      queryFn: () => api.get<BotTemplateDetail>(`/admin/bot-templates/${id}`),
      enabled: !!id,
    }),
};

export function useAdminBotTemplates() {
  return useQuery(options.list());
}

export function useAdminBotTemplateDetail(id: string) {
  return useQuery(options.detail(id));
}

function useInvalidate() {
  const qc = useQueryClient();
  return (id?: string) => {
    qc.invalidateQueries({ queryKey: queryKeys.admin.botTemplates() });
    if (id) qc.invalidateQueries({ queryKey: queryKeys.admin.botTemplateDetail(id) });
  };
}

export function useCreateBotTemplate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { key: string; displayName: string; category?: string; description?: string; availableToAllTenants?: boolean }) =>
      api.post<{ template: BotTemplate }>('/admin/bot-templates', input),
    onSuccess: () => {
      invalidate();
      toast.success('Template created');
    },
  });
}

export function useUpdateBotTemplate(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: Partial<Pick<BotTemplate, 'displayName' | 'category' | 'description' | 'availableToAllTenants'>>) =>
      api.put<{ template: BotTemplate }>(`/admin/bot-templates/${id}`, input),
    onSuccess: () => {
      invalidate(id);
      toast.success('Template updated');
    },
  });
}

export function useArchiveBotTemplate(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { force?: boolean } = {}) =>
      api.post<{ reassignedTenants: string[] }>(`/admin/bot-templates/${id}/archive`, input),
    onSuccess: () => {
      invalidate(id);
      toast.success('Template archived');
    },
    onError: toastUnlessForceConflict,
  });
}

export function useCreateTemplateVersion(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { body: string; changelog?: string | null; expectedModules?: string[]; selectedModuleRefs?: { moduleId: string; moduleVersion: number }[] | null; config?: BotTemplateConfig }) =>
      api.post<{ version: BotTemplateVersion; warnings: string[] }>(`/admin/bot-templates/${id}/versions`, input),
    onSuccess: (res) => {
      invalidate(id);
      (res.warnings ?? []).forEach((w) => toast.warning(w));
      toast.success(`Draft v${res.version.version} created`);
    },
  });
}

export function useEditTemplateVersion(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { version: number; body?: string; changelog?: string | null; expectedModules?: string[]; selectedModuleRefs?: { moduleId: string; moduleVersion: number }[] | null; config?: BotTemplateConfig; lockVersion: number }) =>
      api.put<{ version: BotTemplateVersion; warnings: string[] }>(`/admin/bot-templates/${id}/versions/${input.version}`, input),
    onSuccess: (res) => {
      invalidate(id);
      (res.warnings ?? []).forEach((w) => toast.warning(w));
      toast.success('Draft saved');
    },
  });
}

export function usePublishTemplateVersion(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (version: number) => api.post<{ version: BotTemplateVersion }>(`/admin/bot-templates/${id}/versions/${version}/publish`),
    onSuccess: (res) => {
      invalidate(id);
      toast.success(`v${res.version.version} published`);
    },
  });
}

export function useUnpublishTemplateVersion(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { version: number; force?: boolean }) =>
      api.post<{ reassignedTenants: string[] }>(`/admin/bot-templates/${id}/versions/${input.version}/unpublish`, { force: input.force }),
    onSuccess: () => {
      invalidate(id);
      toast.success('Version unpublished');
    },
    onError: toastUnlessForceConflict,
  });
}

export function useTemplateTestChat() {
  return useMutation({
    mutationFn: (input: { body: string; config: BotTemplateConfig; message: string; history: { role: 'user' | 'assistant'; content: string }[] }) =>
      api.post<{ response: string }>(`/admin/bot-templates/test-chat`, input),
  });
}

export interface PreviewLedgerResponse {
  prompt: string;
  scope: 'customer_reply';
  includedBlocks: string[];
  excludedBlocks: { key: string; reason: string }[];
  allowedTools: string[];
  caveat: string;
}

/** L10/Phase 4 — compile a template under a mock {tier, channel, activeModules}
 *  context and return the block ledger (no LLM call). */
export function usePreviewLedger() {
  return useMutation({
    mutationFn: (input: {
      body: string;
      config: BotTemplateConfig;
      tier?: 'free' | 'essential' | 'pro' | 'enterprise';
      channel?: string;
      activeModules?: string[];
    }) => api.post<PreviewLedgerResponse>(`/admin/bot-templates/preview-ledger`, input),
  });
}

export interface UnavailableTemplateBot {
  botId: string;
  tenantId: string;
  botName: string;
  templateId: string;
  pinnedVersion: string | null;
  tenantName: string;
  reason: 'missing_or_archived' | 'no_published_version';
}

/** L9 — superadmin: bots whose bound template is unavailable (missing/archived or
 *  has no published version). Read-only operational snapshot. */
export function useUnavailableTemplates() {
  return useQuery({
    queryKey: ['admin', 'observability', 'unavailable-templates'],
    queryFn: () => api.get<{ bots: UnavailableTemplateBot[]; count: number }>(
      '/admin/observability/unavailable-templates',
    ),
  });
}

export function useDeleteTemplateVersion(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { version: number; force?: boolean }) =>
      api.delete<{ reassignedTenants: string[] }>(`/admin/bot-templates/${id}/versions/${input.version}`, { data: { force: input.force } }),
    onSuccess: () => {
      invalidate(id);
      toast.success('Version deleted');
    },
    onError: toastUnlessForceConflict,
  });
}

export function useRollbackTemplate(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (fromVersion: number) => api.post<{ version: BotTemplateVersion }>(`/admin/bot-templates/${id}/rollback`, { fromVersion }),
    onSuccess: (res) => {
      invalidate(id);
      toast.success(`Rolled back — published v${res.version.version}`);
    },
  });
}

export function useUpdateTemplateGrants(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { tenantIds: string[]; force?: boolean }) =>
      api.put<{ granted: string[]; reassignedTenants: string[] }>(`/admin/bot-templates/${id}/grants`, input),
    onSuccess: () => {
      invalidate(id);
      toast.success('Access updated');
    },
    onError: toastUnlessForceConflict,
  });
}

// ── Authored Modules (composable-templates Phase 5) ──────────────────────────

export interface AdminModuleVersion {
  id: string;
  moduleId: string;
  version: number;
  prose: string;
  status: 'draft' | 'published' | 'unpublished';
  lockVersion: number;
}

export interface AdminModule {
  id: string;
  name: string;
  description: string | null;
  /** Engineered skill ids this module binds (v1: exactly 1). */
  skillIds: string[];
}

export interface AdminModuleRow {
  module: AdminModule;
  versions: AdminModuleVersion[];
}

/**
 * Super-admin authored-module catalog (GET /admin/modules) — feeds the composable
 * editor's module multi-select. `enabled` lets the page skip the fetch when the
 * composable-templates flag is OFF (the legacy editor never reads it).
 */
export function useAdminModules(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['admin', 'modules'] as const,
    queryFn: async () => {
      const res = await api.get<{ modules: AdminModuleRow[] }>('/admin/modules');
      return res.modules;
    },
    enabled: opts.enabled ?? true,
  });
}
