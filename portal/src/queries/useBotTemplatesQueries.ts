import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

export type TemplateStatus = 'active' | 'archived';
export type VersionStatus = 'draft' | 'published' | 'unpublished';
/** Commercial tier the template is catalogued under (mirrors plan names). */
export type TemplateTier = 'essential' | 'pro' | 'enterprise';

/** A custom placeholder a template declares for tenants to fill (a "blank"). */
export interface TemplateVariable {
  key: string;
  label?: string;
  help?: string;
  required?: boolean;
  default?: string;
}

export interface BotTemplateSummary {
  id: string;
  key: string;
  displayName: string;
  category: string | null;
  description: string | null;
  tier: TemplateTier;
  availableToAllTenants: boolean;
  status: TemplateStatus;
  /** Skill ids the current published version binds — the template's composition. */
  skills: string[];
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
  tier: TemplateTier;
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
  /** Composable-templates: bound skill ids (module==skill, 1:1). Authoritative when
   *  present; falls back to expectedModules when null. Pinned at publish time. */
  selectedSkillIds?: string[] | null;
  /** Per-template prose overrides (skillId → prose) for this version. */
  skillProse?: Record<string, string> | null;
  /** Custom {placeholders} this version declares for tenants to fill. */
  variables?: TemplateVariable[] | null;
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
    mutationFn: (input: { key: string; displayName: string; category?: string; description?: string; tier?: TemplateTier; availableToAllTenants?: boolean }) =>
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
    mutationFn: (input: Partial<Pick<BotTemplate, 'displayName' | 'category' | 'description' | 'tier' | 'availableToAllTenants'>>) =>
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
    mutationFn: (input: { body: string; changelog?: string | null; expectedModules?: string[]; selectedSkillIds?: string[] | null; skillProse?: Record<string, string> | null; variables?: TemplateVariable[] | null; config?: BotTemplateConfig }) =>
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
    mutationFn: (input: { version: number; body?: string; changelog?: string | null; expectedModules?: string[]; selectedSkillIds?: string[] | null; skillProse?: Record<string, string> | null; variables?: TemplateVariable[] | null; config?: BotTemplateConfig; lockVersion: number }) =>
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

// ── Skills catalog (composable-templates: module==skill, 1:1) ────────────────

/** The engineered skill catalog (read-only) — the bindable skills. */
export interface AdminSkill {
  id: string;
  displayName: string;
  description: string | null;
  readinessHint: string | null;
  /** The skill's canonical prose (frozen in code) — seeds a per-template override. */
  defaultProse: string;
  /** Entitlement feature that gates the skill (e.g. 'bookings'), or null. */
  feature: string | null;
  /** Tool names the skill gives the bot (display). */
  provides: string[];
  /** Whether the skill needs per-bot setup (e.g. booking's calendar) vs ready-once-entitled. */
  needsSetup: boolean;
}
export function useAdminSkills(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['admin', 'skills'] as const,
    queryFn: async () => {
      const res = await api.get<{ skills: AdminSkill[] }>('/admin/skills');
      return res.skills;
    },
    enabled: opts.enabled ?? true,
  });
}

/** Bulk-bind a skill to every active template in a tier (unions it into each
 *  template's latest published version). One click, tier-wide. */
export function useApplySkillToTier() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ skillId, tier }: { skillId: string; tier: TemplateTier }) =>
      api.post<{ applied: number; skipped: number; total: number }>(`/admin/skills/${skillId}/apply-to-tier`, { tier }),
    onSuccess: (res) => {
      invalidate();
      toast.success(`Applied to ${res.applied} template${res.applied === 1 ? '' : 's'}${res.skipped ? ` · ${res.skipped} already had it` : ''}`);
    },
  });
}

