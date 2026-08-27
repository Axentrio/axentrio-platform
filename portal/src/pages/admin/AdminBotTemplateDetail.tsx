/**
 * Super-admin Bot Template editor (.scratch/plan-bot-templates.md, Phase 3b):
 * metadata + versions (draft/publish/unpublish/rollback) + per-tenant grants.
 *
 * Destructive ops (archive, unpublish a pinned version, removing a grant from a
 * tenant with bound bots) use a confirm-then-force flow: try without force →
 * the API answers 409 with an impacted count → confirm → retry with force,
 * which reassigns affected bots to blank-base (T21).
 */
import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Check, X, ChevronsUpDown, Eye, MoreVertical, TriangleAlert, Boxes, Cpu, Pencil, ShieldCheck, Sparkles, FlaskConical, SlidersHorizontal } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import TagInput from '@/pages/knowledge/TagInput';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { useAdminTenantsAll } from '@/queries/useAdminQueries';
import { SkillStateCard } from '@/components/SkillStateCard';
import { COMPOSABLE_TEMPLATES_ENABLED } from '@/config/featureFlags';
import type { SkillState } from '@contracts/skill-readiness';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  useAdminBotTemplateDetail, useUpdateBotTemplate, useArchiveBotTemplate,
  useCreateTemplateVersion, useEditTemplateVersion, usePublishTemplateVersion,
  useUnpublishTemplateVersion, useDeleteTemplateVersion, useRollbackTemplate, useUpdateTemplateGrants, useTemplateTestChat,
  usePreviewLedger, useAdminSkills,
  forceConflict, type AdminSkill, type BotTemplateVersion, type PreviewLedgerResponse,
  type TemplateTier, type TemplateVariable,
} from '../../queries/useBotTemplatesQueries';

import {
  TIER_OPTIONS, DEFAULT_CONFIDENCE, LENGTH_PRESETS, COMMON_TOPICS, TIER_LABELS, CHANNEL_LABELS,
  PREVIEW_CAPABILITIES, REASON_TEXT, SKILL_PREVIEW, stateToRemedy, PREVIEW_HIDDEN_BLOCKS, EXCLUDED_NOTE,
} from './bot-template-detail/template-constants';
import {
  EMPTY_CONFIG, EMPTY_DRAFT, configToDraft, draftToConfig, countGuardrails,
  type ConfigDraft, type VersionDraft,
} from './bot-template-detail/template-draft-types';
import { appendChip, prettifyKey, unknownPlaceholders, renderPromptWithVars } from './bot-template-detail/template-prompt-utils';
import { PlaceholderBar, BlockKey, FieldHint, AuthorSection, RailLabel } from './bot-template-detail/template-ui-bits';

/* ------------------------------------------------------------------ */
/*  Editor helpers                                                      */
/* ------------------------------------------------------------------ */

/** Editor heading per draft mode (create/view/edit). */
const EDITOR_TITLE_KEYS: Record<VersionDraft['mode'], string> = {
  create: 'admin.botTemplates.editor.newTitle',
  view: 'admin.botTemplates.editor.viewTitle',
  edit: 'admin.botTemplates.editor.editTitle',
};

type PreviewTier = 'free' | 'essential' | 'pro' | 'enterprise';
type TestMessage = { role: 'user' | 'assistant'; content: string };
type ModuleCatalog = Array<{ id: string; displayName: string }>;

/* ------------------------------------------------------------------ */
/*  Page sections                                                       */
/* ------------------------------------------------------------------ */

/** Live (latest published) system prompt, with its {variables} highlighted. */
const CurrentPromptCard: React.FC<{
  publishedVersion: BotTemplateVersion | undefined;
  onEditNewVersion: () => void;
}> = ({ publishedVersion, onEditNewVersion }) => {
  const { t } = useTranslation();
  return (
    <Card variant="glass">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CardTitle>{t('admin.botTemplates.detail.currentPrompt')}</CardTitle>
          {publishedVersion && <Badge variant="default">{`v${publishedVersion.version}`}</Badge>}
        </div>
        <Button size="sm" variant="outline" onClick={() => onEditNewVersion()}>
          <Pencil className="h-3.5 w-3.5" />{t('admin.botTemplates.actions.editNewVersion')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {publishedVersion ? (
          <>
            {publishedVersion.body?.trim() ? (
              <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-edge bg-surface-1 p-4 text-sm leading-relaxed text-text-secondary">
                {renderPromptWithVars(publishedVersion.body)}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-edge bg-surface-1 p-4 text-sm text-text-muted">
                {t('admin.botTemplates.detail.promptEmpty')}
              </div>
            )}
            <div className="flex items-center gap-1.5 text-xs text-text-muted">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              {countGuardrails(publishedVersion.config) === 0
                ? t('admin.botTemplates.detail.promptConfigDefaults')
                : t('admin.botTemplates.detail.promptConfigSummary', { count: countGuardrails(publishedVersion.config) })}
            </div>
          </>
        ) : (
          <p className="text-sm text-text-muted">{t('admin.botTemplates.detail.noPublishedPrompt')}</p>
        )}
      </CardContent>
    </Card>
  );
};

/** Per-tenant access grants (only relevant when not globally available). */
const GrantsCard: React.FC<{
  availableToAllTenants: boolean;
  tenants: Array<{ id: string; name: string }>;
  selectedTenantIds: string[];
  tenantName: (tid: string) => string;
  onToggleTenant: (tid: string) => void;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  isSaving: boolean;
  onSave: () => void;
}> = ({
  availableToAllTenants,
  tenants,
  selectedTenantIds,
  tenantName,
  onToggleTenant,
  pickerOpen,
  onPickerOpenChange,
  isSaving,
  onSave,
}) => {
  const { t } = useTranslation();
  return (
    <Card variant="glass">
      <CardHeader><CardTitle>{t('admin.botTemplates.detail.grants')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-text-tertiary">
          {availableToAllTenants ? t('admin.botTemplates.detail.grantsGlobalHint') : t('admin.botTemplates.detail.grantsHint')}
        </p>

        {!availableToAllTenants && (
          <>
            {/* Searchable tenant multi-select */}
            <Popover open={pickerOpen} onOpenChange={onPickerOpenChange}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" className="w-full justify-between">
                  {selectedTenantIds.length
                    ? t('admin.botTemplates.detail.tenantsSelected', { count: selectedTenantIds.length })
                    : t('admin.botTemplates.detail.tenantsSelectPlaceholder')}
                  <ChevronsUpDown className="h-4 w-4 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command filter={(value, search) => (value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}>
                  <CommandInput placeholder={t('admin.botTemplates.detail.tenantsSearch')} />
                  <CommandList>
                    <CommandEmpty>{t('admin.botTemplates.detail.tenantsNone')}</CommandEmpty>
                    <CommandGroup>
                      {tenants.map((tenant) => {
                        const checked = selectedTenantIds.includes(tenant.id);
                        return (
                          <CommandItem key={tenant.id} value={`${tenant.name} ${tenant.id}`} onSelect={() => onToggleTenant(tenant.id)}>
                            <Check className={`mr-2 h-4 w-4 ${checked ? 'opacity-100' : 'opacity-0'}`} />
                            <span className="truncate">{tenant.name}</span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {/* Selected chips */}
            {selectedTenantIds.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedTenantIds.map((tid) => (
                  <Badge key={tid} variant="secondary" className="gap-1">
                    {tenantName(tid)}
                    <button type="button" onClick={() => onToggleTenant(tid)} aria-label="remove">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}

            <div className="flex justify-end">
              <Button
                variant="outline"
                disabled={isSaving}
                onClick={onSave}
              >
                {t('admin.botTemplates.actions.saveAccess')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};

/* ------------------------------------------------------------------ */
/*  Version editor sections                                             */
/* ------------------------------------------------------------------ */

/** Editor takeover header: title, unsaved badge, context line, actions. */
const VersionEditorHeader: React.FC<{
  editorTitle: string;
  mode: VersionDraft['mode'];
  dirty: boolean;
  category: string | null;
  latestVersion: BotTemplateVersion | undefined;
  createPending: boolean;
  editPending: boolean;
  publishPending: boolean;
  onClose: () => void;
  onCancel: () => void;
  onSaveDraft: () => void;
  onPublish: () => void;
}> = ({
  editorTitle,
  mode,
  dirty,
  category,
  latestVersion,
  createPending,
  editPending,
  publishPending,
  onClose,
  onCancel,
  onSaveDraft,
  onPublish,
}) => {
  const { t } = useTranslation();
  const editorBusy = createPending || editPending || publishPending;
  return (
    <header className="relative flex flex-wrap items-center gap-3 border-b border-edge bg-surface-1/70 px-5 py-3 shrink-0 backdrop-blur">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary-500/60 to-transparent" />
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-500/10 text-primary-300 ring-1 ring-inset ring-primary-500/25">
          {mode === 'view' ? <Eye className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-text-primary">{editorTitle}</h2>
            {mode === 'view'
              ? <Badge variant="secondary" className="shrink-0">{t('admin.botTemplates.versionStatus.published')}</Badge>
              : dirty && (
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/25">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />{t('admin.botTemplates.editor.unsaved')}
                </span>
              )}
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-tertiary">
            {category && (
              <span className="truncate">{t('admin.botTemplates.detail.category')}: <span className="font-mono text-text-secondary">{category}</span></span>
            )}
            {mode === 'create' && latestVersion && (
              <><span className="text-text-muted">·</span><span className="truncate">{t('admin.botTemplates.editor.prefilledFrom', { version: latestVersion.version })}</span></>
            )}
          </div>
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {mode === 'view' ? (
          <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
            <Button variant="outline" onClick={onSaveDraft} disabled={editorBusy}>{t('admin.botTemplates.editor.saveDraft')}</Button>
            <Button onClick={onPublish} disabled={editorBusy} className="gap-1.5">
              <Check className="h-4 w-4" />{t('admin.botTemplates.actions.publish')}
            </Button>
          </>
        )}
      </div>
    </header>
  );
};

/** 01 — Prompt: the hero, framed as a real editor surface. */
const PromptSection: React.FC<{
  draft: VersionDraft;
  setDraft: React.Dispatch<React.SetStateAction<VersionDraft>>;
  customChips: string[];
  onManageVariables: () => void;
}> = ({ draft, setDraft, customChips, onManageVariables }) => {
  const { t } = useTranslation();
  return (
    <AuthorSection
      step={1}
      icon={Sparkles}
      title={COMPOSABLE_TEMPLATES_ENABLED ? t('admin.botTemplates.editor.generalPrompt') : t('admin.botTemplates.editor.promptSection')}
      hint={draft.mode !== 'view' ? (COMPOSABLE_TEMPLATES_ENABLED ? t('admin.botTemplates.editor.generalPromptHint') : t('admin.botTemplates.editor.bodyHint')) : undefined}
    >
      <div className="overflow-hidden rounded-xl border border-edge bg-surface-1 transition-colors focus-within:border-primary-400 focus-within:ring-2 focus-within:ring-primary-500/25">
        <div className="flex items-center justify-between gap-2 border-b border-edge/70 bg-surface-2/40 px-3 py-2">
          <Label htmlFor="d-body" className="text-xs font-medium uppercase tracking-wide text-text-secondary">
            {COMPOSABLE_TEMPLATES_ENABLED ? t('admin.botTemplates.editor.generalPrompt') : t('admin.botTemplates.editor.body')}
          </Label>
          <span className="font-mono text-[11px] tabular-nums text-text-muted">{t('admin.botTemplates.editor.charCount', { n: draft.body.length.toLocaleString() })}</span>
        </div>
        <Textarea
          id="d-body"
          rows={16}
          className="rounded-none border-0 bg-transparent font-mono text-sm leading-relaxed hover:border-0 focus-visible:border-0 focus-visible:ring-0"
          value={draft.body}
          readOnly={draft.mode === 'view'}
          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
        />
        {/* The placeholder bar always renders. In view mode it is a
            non-inserting REFERENCE so anyone reading a template can see which
            placeholders exist (hiding it entirely made authors think booking
            placeholders were "missing"). In edit mode the chips insert. */}
        <PlaceholderBar
          readOnly={draft.mode === 'view'}
          customChips={customChips}
          onManage={onManageVariables}
          onInsert={(p) => setDraft((d) => ({ ...d, body: appendChip(d.body, p) }))}
        />
      </div>
    </AuthorSection>
  );
};

/** 02 — Capabilities: the modules → skills the bot actually gets. */
const CapabilitiesSection: React.FC<{
  draft: VersionDraft;
  setDraft: React.Dispatch<React.SetStateAction<VersionDraft>>;
  skillsCatalog: AdminSkill[] | undefined;
  moduleCatalog: ModuleCatalog;
  customChips: string[];
  onManageVariables: () => void;
}> = ({ draft, setDraft, skillsCatalog, moduleCatalog, customChips, onManageVariables }) => {
  const { t } = useTranslation();
  return (
    <AuthorSection
      step={2}
      icon={Boxes}
      title={COMPOSABLE_TEMPLATES_ENABLED ? t('admin.botTemplates.editor.modules') : t('admin.botTemplates.editor.expectedModules')}
      hint={COMPOSABLE_TEMPLATES_ENABLED ? t('admin.botTemplates.editor.modulesHint') : t('admin.botTemplates.editor.expectedModulesHint')}
    >
      {COMPOSABLE_TEMPLATES_ENABLED ? (
        (() => {
          const ro = draft.mode === 'view';
          const toggleSkill = (sid: string) =>
            setDraft((d) => ({
              ...d,
              selectedSkillIds: d.selectedSkillIds.includes(sid)
                ? d.selectedSkillIds.filter((x) => x !== sid)
                : [...d.selectedSkillIds, sid],
            }));
          const skills = skillsCatalog ?? [];
          if (skills.length === 0) {
            return <p className="rounded-lg border border-dashed border-edge bg-surface-1 px-3 py-4 text-xs text-text-muted">{t('admin.botTemplates.editor.noModulesPublished')}</p>;
          }
          const setProse = (sid: string, val: string) =>
            setDraft((d) => ({ ...d, skillProse: { ...d.skillProse, [sid]: val } }));
          const resetProse = (sid: string) =>
            setDraft((d) => { const next = { ...d.skillProse }; delete next[sid]; return { ...d, skillProse: next }; });
          // One card per skill: tick to bind, and a bound skill reveals its prose
          // inline (pre-filled with the code default; edit to override for this
          // template only). Skill + its prose live together — no wall of textareas.
          return (
            <div className="space-y-2">
              {skills.map((skill) => {
                const checked = draft.selectedSkillIds.includes(skill.id);
                const custom = draft.skillProse[skill.id] !== undefined && draft.skillProse[skill.id].trim() !== skill.defaultProse.trim();
                return (
                  <div
                    key={skill.id}
                    className={`overflow-hidden rounded-lg border transition-colors ${checked ? 'border-primary-400/50 bg-primary-500/[0.06]' : 'border-edge bg-surface-1'}`}
                  >
                    <label className={`flex items-start gap-2.5 p-3 ${ro ? 'pointer-events-none opacity-70' : 'cursor-pointer'} ${checked ? '' : 'hover:bg-surface-2'}`}>
                      <Checkbox checked={checked} onCheckedChange={() => toggleSkill(skill.id)} disabled={ro} className="mt-0.5" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-medium text-text-primary">
                          <Cpu className="h-3.5 w-3.5 shrink-0 text-text-muted" />{skill.displayName}
                          {checked && (
                            <span className={`rounded px-1 text-[9px] font-medium uppercase tracking-wide ${custom ? 'bg-primary-500/15 text-primary-300' : 'bg-surface-3 text-text-muted'}`}>
                              {custom ? 'custom prose' : 'default prose'}
                            </span>
                          )}
                        </span>
                        {skill.description && (
                          <span className="mt-0.5 block text-xs text-text-muted">{skill.description}</span>
                        )}
                      </span>
                    </label>

                    {checked && (
                      <div className="space-y-1.5 border-t border-edge/60 bg-surface-0/40 p-3 pt-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">Prose · this template only</span>
                          {!ro && custom && (
                            <button type="button" onClick={() => resetProse(skill.id)} className="text-[11px] font-medium text-primary-400 hover:text-primary-300">
                              Reset to default
                            </button>
                          )}
                        </div>
                        <div className="overflow-hidden rounded-md border border-edge bg-surface-1">
                          <Textarea
                            aria-label={`${skill.displayName} prose`}
                            rows={3}
                            readOnly={ro}
                            value={draft.skillProse[skill.id] ?? skill.defaultProse}
                            onChange={(e) => setProse(skill.id, e.target.value)}
                            className="rounded-none border-0 bg-transparent text-xs leading-relaxed hover:border-0 focus-visible:border-0 focus-visible:ring-0"
                          />
                          <PlaceholderBar
                            readOnly={ro}
                            customChips={customChips}
                            onManage={onManageVariables}
                            onInsert={(p) => setProse(skill.id, appendChip(draft.skillProse[skill.id] ?? skill.defaultProse, p))}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()
      ) : (
        (() => {
          const ro = draft.mode === 'view';
          const modulesArr = draft.expectedModules.split(',').map((x) => x.trim()).filter(Boolean);
          const toggleModule = (mid: string) => {
            const next = modulesArr.includes(mid) ? modulesArr.filter((x) => x !== mid) : [...modulesArr, mid];
            setDraft((d) => ({ ...d, expectedModules: next.join(', ') }));
          };
          if (moduleCatalog.length === 0) return <p className="rounded-lg border border-dashed border-edge bg-surface-1 px-3 py-4 text-xs text-text-tertiary">{t('admin.botTemplates.editor.noModules')}</p>;
          return (
            <div className="flex flex-wrap gap-1.5">
              {moduleCatalog.map((mod) => {
                const selected = modulesArr.includes(mod.id);
                return (
                  <Button key={mod.id} type="button" size="sm" variant={selected ? 'default' : 'outline'} className="h-8 text-xs" disabled={ro} onClick={() => toggleModule(mod.id)}>
                    {selected && <Check className="h-3 w-3 mr-1" />}{mod.displayName}
                  </Button>
                );
              })}
            </div>
          );
        })()
      )}
    </AuthorSection>
  );
};

/** 05 — Test this prompt: try the current draft (body + config) before publishing. */
const TestPromptSection: React.FC<{
  log: TestMessage[];
  input: string;
  setInput: (value: string) => void;
  isPending: boolean;
  onRun: () => void;
}> = ({ log, input, setInput, isPending, onRun }) => {
  const { t } = useTranslation();
  return (
    <AuthorSection step={5} icon={FlaskConical} title={t('admin.botTemplates.editor.testTitle')} hint={t('admin.botTemplates.editor.testHint')} last>
      <div className="space-y-3 rounded-xl border border-edge bg-surface-1 p-4">
        {log.length > 0 && (
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg bg-surface-2 p-2">
            {log.map((mtest, i) => (
              <div key={i} className={mtest.role === 'user' ? 'text-right' : 'text-left'}>
                <span className={`inline-block rounded-lg px-2.5 py-1.5 text-xs ${mtest.role === 'user' ? 'bg-primary-600 text-white' : 'bg-surface-3 text-text-primary'}`}>
                  {mtest.content}
                </span>
              </div>
            ))}
            {isPending && <p className="text-xs text-text-tertiary">{t('admin.botTemplates.editor.testThinking')}</p>}
          </div>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={input}
            placeholder={t('admin.botTemplates.editor.testPlaceholder')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onRun(); } }}
          />
          <Button type="button" onClick={() => onRun()} disabled={isPending || !input.trim()}>
            {t('admin.botTemplates.editor.testSend')}
          </Button>
        </div>
      </div>
    </AuthorSection>
  );
};

/** RIGHT rail — live preview: a "monitor". Outcomes first, ledger on demand. */
const PreviewRail: React.FC<{
  tier: PreviewTier;
  setTier: (value: PreviewTier) => void;
  channel: string;
  setChannel: (value: string) => void;
  isPending: boolean;
  ledger: PreviewLedgerResponse | undefined;
  selectedSkillIds: string[];
  skillsCatalog: AdminSkill[] | undefined;
}> = ({ tier, setTier, channel, setChannel, isPending, ledger, selectedSkillIds, skillsCatalog }) => {
  return (
    <aside className="relative space-y-4 overflow-y-auto border-t border-edge bg-surface-0 p-5 lg:border-l lg:border-t-0">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 hidden h-px bg-gradient-to-r from-transparent via-primary-500/40 to-transparent lg:block" />
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-2 text-primary-300 ring-1 ring-inset ring-edge">
          <Eye className="h-3.5 w-3.5" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Preview a scenario</h3>
        </div>
      </div>
      <p className="text-xs text-text-tertiary">Simulated — what a bot on this template would receive. Not this bot’s real settings.</p>

      <div className="space-y-3 rounded-xl border border-edge bg-surface-1 p-3">
        <div>
          <label className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
            <SlidersHorizontal className="h-3 w-3" />Plan
          </label>
          <Select value={tier} onValueChange={(v) => setTier(v as PreviewTier)}>
            <SelectTrigger aria-label="Plan" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{(['free', 'essential', 'pro', 'enterprise'] as const).map((x) => <SelectItem key={x} value={x}>{TIER_LABELS[x]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-text-tertiary">Preview channel</span>
          <Select value={channel} onValueChange={setChannel}>
            <SelectTrigger aria-label="Channel" className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{(['widget', 'whatsapp', 'instagram', 'messenger', 'telegram'] as const).map((x) => <SelectItem key={x} value={x}>{CHANNEL_LABELS[x]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <p className="text-[10px] leading-relaxed text-text-tertiary">{COMPOSABLE_TEMPLATES_ENABLED ? 'Booking and other skills follow the modules you select. Channel only tweaks reply length and proactive contact.' : 'Booking and other modules follow the template’s Expected modules. Channel only tweaks reply length and proactive contact.'}</p>
      </div>

      {isPending && (
        <p className="flex items-center gap-2 text-xs text-text-tertiary">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary-400" />Compiling…
        </p>
      )}
      {ledger ? (() => {
        const included = ledger.includedBlocks.filter((b) => !PREVIEW_HIDDEN_BLOCKS[b]);
        const excluded = ledger.excludedBlocks.filter((e) => !PREVIEW_HIDDEN_BLOCKS[e.key]);
        return (
          <>
            <div className="space-y-2 rounded-xl border border-edge bg-surface-1 p-3">
              <RailLabel>In this scenario the bot can</RailLabel>
              <div className="space-y-1.5">
                {PREVIEW_CAPABILITIES.map((cap) => {
                  const on = ledger.allowedTools.includes(cap.tool);
                  return (
                    <div key={cap.tool} className={`flex items-start gap-2 text-xs ${on ? 'text-text-primary' : 'text-text-muted'}`}>
                      {on
                        ? <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-status-online/15"><Check className="h-2.5 w-2.5 text-status-online" /></span>
                        : <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-status-away/15"><TriangleAlert className="h-2.5 w-2.5 text-status-away" /></span>}
                      <span>{cap.label}{!on && cap.whenAbsent ? ` — ${cap.whenAbsent}` : ''}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Composable-templates: per-skill state badges for the modules
                this template binds, derived from the scenario ledger. */}
            {COMPOSABLE_TEMPLATES_ENABLED && (() => {
              const skills = selectedSkillIds;
              if (skills.length === 0) {
                return <p className="rounded-xl border border-dashed border-edge px-3 py-3 text-xs text-text-muted">Add a skill on the left to preview it.</p>;
              }
              return (
                <div className="space-y-1.5">
                  <RailLabel>Skills</RailLabel>
                  {skills.map((sid) => {
                    const meta = skillsCatalog?.find((s) => s.id === sid);
                    const provides = meta?.provides ?? SKILL_PREVIEW[sid]?.tools ?? [];
                    const readyTools = provides.filter((tn) => ledger.allowedTools.includes(tn));
                    // A skill that needs per-bot setup (booking) reads ready only when its
                    // tools surface; inert catalog skills (handoff, lead capture) need no
                    // setup, so they read ready as soon as the template composes them.
                    const state: SkillState =
                      meta && !meta.needsSetup ? 'ready' : readyTools.length > 0 ? 'ready' : 'unconfigured';
                    const name = meta?.displayName ?? SKILL_PREVIEW[sid]?.label ?? sid;
                    return <SkillStateCard key={sid} skill={{ id: sid, name, state, remedy: stateToRemedy(state) }} readyTools={readyTools} />;
                  })}
                </div>
              );
            })()}

            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="tech" className="rounded-xl border border-edge px-4 border-b">
                <AccordionTrigger className="hover:no-underline text-xs font-medium">Show technical details</AccordionTrigger>
                <AccordionContent className="space-y-3 text-xs">
                  <TooltipProvider delayDuration={150}>
                    <div>
                      <div className="mb-1 text-[10px] uppercase tracking-wider text-text-tertiary">Prompt blocks included ({included.length})</div>
                      {included.map((b) => (
                        <div key={b} className="flex items-center gap-2 border-b border-edge/40 py-1 font-mono text-text-primary"><Check className="h-3 w-3 shrink-0 text-status-online" /><BlockKey name={b} /></div>
                      ))}
                    </div>
                    {excluded.length > 0 && (
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-text-tertiary">Not in this scenario ({excluded.length})</div>
                        {excluded.map((e) => (
                          <div key={e.key} className="flex items-center gap-2 border-b border-edge/40 py-1 font-mono text-text-tertiary"><X className="h-3 w-3 shrink-0" /><BlockKey name={e.key} /><span className="ml-auto rounded border border-edge bg-surface-2 px-1.5 py-0.5 font-sans text-[10px]">{EXCLUDED_NOTE[e.key] ?? REASON_TEXT[e.reason] ?? e.reason}</span></div>
                        ))}
                      </div>
                    )}
                    <div className="font-mono text-text-secondary"><span className="mb-1 block text-[10px] uppercase tracking-wider text-text-tertiary">Tools available</span>{ledger.allowedTools.join(', ') || '—'}</div>
                  </TooltipProvider>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </>
        );
      })() : !isPending ? (
        <div className="rounded-xl border border-dashed border-edge px-4 py-8 text-center">
          <Eye className="mx-auto mb-2 h-5 w-5 text-text-muted" />
          <p className="text-xs text-text-tertiary">Write the prompt — a preview of what the bot can do appears here.</p>
        </div>
      ) : null}
    </aside>
  );
};

const AdminBotTemplateDetail: React.FC = () => {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const { data, isLoading, isError } = useAdminBotTemplateDetail(id);
  // Tenant list for the access picker — only fetched when this template is not
  // globally available (i.e. per-tenant grants are actually used).
  const { data: tenantList } = useAdminTenantsAll({ enabled: data?.template ? !data.template.availableToAllTenants : false });

  const updateMut = useUpdateBotTemplate(id);
  const archiveMut = useArchiveBotTemplate(id);
  const createVersionMut = useCreateTemplateVersion(id);
  const editVersionMut = useEditTemplateVersion(id);
  const publishMut = usePublishTemplateVersion(id);
  const unpublishMut = useUnpublishTemplateVersion(id);
  const deleteMut = useDeleteTemplateVersion(id);
  const rollbackMut = useRollbackTemplate(id);
  const grantsMut = useUpdateTemplateGrants(id);
  const testChat = useTemplateTestChat();
  const preview = usePreviewLedger();
  // Composable-templates: the skill catalog for the skill multi-select (module==
  // skill). Only fetched when the flag is ON (the legacy editor never reads it).
  const { data: skillsCatalog } = useAdminSkills({ enabled: COMPOSABLE_TEMPLATES_ENABLED });
  const draftBaselineRef = useRef<string>('');

  const [meta, setMeta] = useState<{ displayName: string; category: string; description: string; tier: TemplateTier; availableToAllTenants: boolean } | null>(null);
  const [draft, setDraft] = useState<VersionDraft>(EMPTY_DRAFT);
  const [newVarName, setNewVarName] = useState('');
  const [varsModalOpen, setVarsModalOpen] = useState(false);
  const [testInput, setTestInput] = useState('');
  const [testLog, setTestLog] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [selectedTenants, setSelectedTenants] = useState<string[] | null>(null);
  const [tenantPickerOpen, setTenantPickerOpen] = useState(false);
  const [pvTier, setPvTier] = useState<'free' | 'essential' | 'pro' | 'enterprise'>('pro');
  const [pvChannel, setPvChannel] = useState('widget');
  const [confirm, setConfirm] = useState<{ open: boolean; title: string; description: string; onConfirm: () => void }>({
    open: false, title: '', description: '', onConfirm: () => {},
  });

  // Live block-ledger: re-compile the preview whenever the open draft's body/config
  // or the mock context changes (debounced). Read-only (no persistence), so it's
  // safe to fire on every edit. preview.data is NOT a dependency → no refresh loop.
  const previewMutate = preview.mutate;
  const draftConfigKey = JSON.stringify(draft.config);

  // The skills the scenario preview activates. Composable: the bound skill ids
  // directly (module==skill, 1:1); legacy: the free-text Expected modules.
  const previewActiveModules = COMPOSABLE_TEMPLATES_ENABLED
    ? draft.selectedSkillIds
    : draft.expectedModules.split(',').map((x) => x.trim()).filter(Boolean);
  const previewActiveModulesKey = previewActiveModules.join(',');

  // Preview re-compiles on body/config or scenario change. The active skills come
  // from THIS form (selected modules when composable, else Expected modules), so
  // the preview reflects what the author declared.
  useEffect(() => {
    if (!draft.open) return;
    const handle = setTimeout(() => {
      previewMutate({
        body: draft.body,
        config: draftToConfig(draft.config),
        tier: pvTier,
        channel: pvChannel,
        activeModules: previewActiveModulesKey ? previewActiveModulesKey.split(',') : [],
      });
    }, 300);
    return () => clearTimeout(handle);
    // draftConfigKey stands in for draft.config (object identity is unstable);
    // previewActiveModulesKey stands in for the derived active-skills array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMutate, draft.open, draft.body, draftConfigKey, pvTier, pvChannel, previewActiveModulesKey]);

  if (isLoading) return <PageSkeleton variant="list" rows={4} />;
  if (isError || !data) return <InlineError message={t('admin.botTemplates.errors.load')} />;

  const { template, versions, grantedTenantIds, usage, moduleCatalog } = data;
  // The live prompt = latest published version (versions are DESC-ordered).
  const publishedVersion = versions.find((v) => v.status === 'published');
  const m = meta ?? {
    displayName: template.displayName,
    category: template.category ?? '',
    description: template.description ?? '',
    tier: template.tier ?? 'essential',
    availableToAllTenants: template.availableToAllTenants,
  };
  const selectedTenantIds = selectedTenants ?? grantedTenantIds;
  const tenants: Array<{ id: string; name: string }> = (tenantList ?? []) as Array<{ id: string; name: string }>;
  const tenantName = (tid: string) => tenants.find((x) => x.id === tid)?.name ?? tid;
  const toggleTenant = (tid: string) =>
    setSelectedTenants((prev) => {
      const base = prev ?? grantedTenantIds;
      return base.includes(tid) ? base.filter((x) => x !== tid) : [...base, tid];
    });

  const parseModules = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  // Try an action without force; on a 409 force-conflict, confirm then retry with force.
  const withForce = async (
    run: (force: boolean) => Promise<unknown>,
    confirmCopy: (n: number) => { title: string; description: string },
  ) => {
    try {
      await run(false);
    } catch (err) {
      const fc = forceConflict(err);
      if (!fc) return; // non-conflict already toasted by the mutation
      const count = fc.impactedBots ?? (fc.impactedTenants ?? []).reduce((a, b) => a + b.bots, 0);
      const copy = confirmCopy(count);
      setConfirm({
        open: true,
        title: copy.title,
        description: copy.description,
        onConfirm: () => {
          setConfirm((c) => ({ ...c, open: false }));
          void run(true);
        },
      });
    }
  };

  // Serialized snapshot of the editable fields, captured when a draft opens, to
  // detect unsaved changes before discarding. (draftBaselineRef hook is declared
  // above the early returns to keep hook order stable.)
  const draftKey = (d: VersionDraft) => JSON.stringify({ body: d.body, changelog: d.changelog, expectedModules: d.expectedModules, selectedSkillIds: d.selectedSkillIds, skillProse: d.skillProse, variables: d.variables, config: d.config });
  const openDraft = (d: VersionDraft) => {
    draftBaselineRef.current = draftKey(d);
    setTestLog([]);
    setTestInput('');
    preview.reset();
    setPvTier('pro');      // preview defaults: Pro plan…
    setPvChannel('widget'); // …on the website widget; modules follow Expected modules
    setDraft(d);
  };

  // Test-this-prompt panel — runs the current draft body+config against the LLM
  // without saving, so authors can try before publishing.
  const runTest = async () => {
    const msg = testInput.trim();
    if (!msg) return;
    const history = testLog;
    setTestLog((l) => [...l, { role: 'user', content: msg }]);
    setTestInput('');
    try {
      const res = await testChat.mutateAsync({ body: draft.body, config: draftToConfig(draft.config), message: msg, history });
      setTestLog((l) => [...l, { role: 'assistant', content: res.response }]);
    } catch {
      setTestLog((l) => [...l, { role: 'assistant', content: t('admin.botTemplates.editor.testError') }]);
    }
  };

  // Discard with a guard: confirm if there are unsaved edits (create/edit only).
  const requestCloseDraft = () => {
    if (draft.mode !== 'view' && draftKey(draft) !== draftBaselineRef.current) {
      setConfirm({
        open: true,
        title: t('admin.botTemplates.confirm.discardTitle'),
        description: t('admin.botTemplates.confirm.discardBody'),
        onConfirm: () => { setConfirm((c) => ({ ...c, open: false })); setDraft(EMPTY_DRAFT); },
      });
    } else {
      setDraft(EMPTY_DRAFT);
    }
  };

  // Prefill a new draft from the most recent version (body + modules + config) so
  // it's an edit-from-here, not a blank slate. Changelog stays empty (new entry).
  const refIds = (v: BotTemplateVersion | undefined): string[] => v?.selectedSkillIds ?? [];
  const openCreate = () => {
    const latest = versions[0];
    openDraft({
      ...EMPTY_DRAFT,
      open: true,
      mode: 'create',
      body: latest?.body ?? '',
      expectedModules: latest ? latest.expectedModules.join(', ') : '',
      selectedSkillIds: refIds(latest),
      skillProse: latest?.skillProse ?? {},
      variables: latest?.variables ?? [],
      config: latest ? configToDraft(latest.config) : EMPTY_CONFIG,
    });
  };
  const openEdit = (v: BotTemplateVersion) =>
    openDraft({ open: true, mode: 'edit', version: v.version, lockVersion: v.lockVersion, body: v.body, changelog: v.changelog ?? '', expectedModules: v.expectedModules.join(', '), selectedSkillIds: refIds(v), skillProse: v.skillProse ?? {}, variables: v.variables ?? [], config: configToDraft(v.config) });
  const openView = (v: BotTemplateVersion) =>
    openDraft({ open: true, mode: 'view', version: v.version, body: v.body, changelog: v.changelog ?? '', expectedModules: v.expectedModules.join(', '), selectedSkillIds: refIds(v), skillProse: v.skillProse ?? {}, variables: v.variables ?? [], config: configToDraft(v.config) });

  // Delete a draft/unpublished version: always confirm; an unpublished version that
  // bots pin then runs the block-or-force flow (unpins them to latest).
  const askDelete = (v: BotTemplateVersion) =>
    setConfirm({
      open: true,
      title: t('admin.botTemplates.confirm.deleteTitle', { version: v.version }),
      description: t('admin.botTemplates.confirm.deleteBody'),
      onConfirm: () => {
        setConfirm((c) => ({ ...c, open: false }));
        if (v.status === 'unpublished') {
          void withForce(
            (force) => deleteMut.mutateAsync({ version: v.version, force }),
            (n) => ({ title: t('admin.botTemplates.confirm.deleteTitle', { version: v.version }), description: t('admin.botTemplates.confirm.deleteReassign', { count: n }) }),
          );
        } else {
          deleteMut.mutate({ version: v.version });
        }
      },
    });

  // The version body shared by save + publish. Composable: persist selectedSkillIds
  // (authoritative, module==skill) and mirror them into expectedModules so the
  // legacy fallback stays consistent. Legacy: free-text Expected modules (flag OFF
  // = unchanged wire shape).
  // Custom {placeholders} the author used ANYWHERE they write — the main body OR a
  // bound skill's prose override — so a variable typed only into module prose is still
  // declared, becomes a tenant-fillable field, and resolves at runtime. Bound skills
  // only (an unbound skill's prose isn't saved).
  const draftCustomKeys = (): string[] => {
    const proseText = Object.entries(draft.skillProse)
      .filter(([k]) => draft.selectedSkillIds.includes(k))
      .map(([, v]) => v)
      .join(' ');
    return unknownPlaceholders(`${draft.body} ${proseText}`);
  };
  const versionPayload = () => {
    const config = draftToConfig(draft.config);
    // One declared variable per custom {placeholder} used in the body OR module prose
    // (drops annotations for placeholders the author removed).
    const variables = draftCustomKeys().map((key) => draft.variables.find((v) => v.key === key) ?? { key });
    if (COMPOSABLE_TEMPLATES_ENABLED) {
      // Keep prose overrides only for still-bound skills; blanks fall back to default.
      const skillProse = Object.fromEntries(
        Object.entries(draft.skillProse).filter(([k, v]) => draft.selectedSkillIds.includes(k) && v.trim()),
      );
      // No skills selected → don't clobber a legacy template's expectedModules;
      // leave selectedSkillIds null so the runtime falls back to expectedModules.
      if (draft.selectedSkillIds.length === 0) {
        return {
          body: draft.body,
          changelog: draft.changelog || null,
          expectedModules: parseModules(draft.expectedModules),
          selectedSkillIds: null,
          skillProse: null,
          variables,
          config,
        };
      }
      return {
        body: draft.body,
        changelog: draft.changelog || null,
        expectedModules: draft.selectedSkillIds,
        selectedSkillIds: draft.selectedSkillIds,
        skillProse,
        variables,
        config,
      };
    }
    return { body: draft.body, changelog: draft.changelog || null, expectedModules: parseModules(draft.expectedModules), variables, config };
  };

  const saveDraft = async () => {
    if (draft.mode === 'create') {
      await createVersionMut.mutateAsync(versionPayload());
    } else {
      await editVersionMut.mutateAsync({ version: draft.version!, lockVersion: draft.lockVersion!, ...versionPayload() });
    }
    setDraft(EMPTY_DRAFT);
  };

  // Save the draft, then publish that version — the one-step path from the editor.
  // Save and publish are separate server calls, so after the save half succeeds we
  // advance the local draft to edit-mode with the server's returned version+lock.
  // That way a retry after a publish failure re-publishes the SAME draft instead of
  // creating a duplicate (create mode) or sending a stale lockVersion (edit mode).
  // Mutations toast their own errors, so a failure just leaves the editor open.
  const publishDraft = async () => {
    try {
      let version: number;
      if (draft.mode === 'create') {
        const res = await createVersionMut.mutateAsync(versionPayload());
        version = res.version.version;
        setDraft((d) => ({ ...d, mode: 'edit', version, lockVersion: res.version.lockVersion }));
      } else {
        const res = await editVersionMut.mutateAsync({ version: draft.version!, lockVersion: draft.lockVersion!, ...versionPayload() });
        version = draft.version!;
        setDraft((d) => ({ ...d, lockVersion: res.version.lockVersion }));
      }
      await publishMut.mutateAsync(version);
      setDraft(EMPTY_DRAFT);
    } catch {
      // Save or publish failed (already toasted). Keep the editor open in its now
      // edit-mode state so the next Publish click resumes from the saved version.
    }
  };

  const editorTitle = t(EDITOR_TITLE_KEYS[draft.mode], { version: draft.version });
  // Unsaved-edits signal for the editor header, mirroring the discard guard.
  const dirty = draft.mode !== 'view' && draftKey(draft) !== draftBaselineRef.current;

  return (
    <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <div>
        <Link to="/admin/bot-templates" className="inline-flex items-center text-sm text-text-secondary transition-colors hover:text-text-primary">
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t('admin.botTemplates.detail.back')}
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{template.displayName}</h1>
              <Badge variant={template.status === 'active' ? 'default' : 'secondary'}>
                {t(`admin.botTemplates.templateStatus.${template.status}`)}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-tertiary">
              <span className="inline-flex items-center rounded-md bg-surface-2 px-2 py-0.5 font-mono text-text-secondary ring-1 ring-inset ring-edge">{template.key}</span>
              <span className="text-text-muted">·</span>
              <span>{t('admin.botTemplates.detail.usage', { bots: usage.bots, tenants: usage.tenants })}</span>
            </div>
          </div>
          {template.status === 'active' && (
            <Button
              variant="outline"
              onClick={() =>
                withForce(
                  (force) => archiveMut.mutateAsync({ force }),
                  (n) => ({ title: t('admin.botTemplates.confirm.archiveTitle'), description: t('admin.botTemplates.confirm.reassign', { count: n }) }),
                )
              }
            >
              {t('admin.botTemplates.actions.archive')}
            </Button>
          )}
        </div>
      </div>


      {/* Details — a settings surface, not a raw form. Two decision groups, each with
          a left-rail explanation: Identity (what the template is) and Distribution
          (who can pick it). Every field keeps its id/label wiring. */}
      <Card variant="glass">
        <CardContent className="p-0">
          {/* Identity */}
          <section className="grid gap-4 border-b border-edge p-5 lg:grid-cols-[220px_1fr] lg:gap-8">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Identity</h3>
              <p className="mt-1 text-xs text-text-muted">How this template is named and catalogued.</p>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="m-name">{t('admin.botTemplates.create.displayName')}</Label>
                <Input id="m-name" value={m.displayName} onChange={(e) => setMeta({ ...m, displayName: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="m-vertical">{t('admin.botTemplates.detail.category')}</Label>
                <Input id="m-vertical" value={m.category} placeholder="plumber" onChange={(e) => setMeta({ ...m, category: e.target.value })} />
                {m.category.trim() ? (
                  <p className="text-xs text-text-secondary">
                    Unlocks the{' '}
                    <span className="rounded bg-surface-2 px-1 font-mono text-text-primary">{m.category.trim()}</span>{' '}
                    specialty catalog.
                  </p>
                ) : (
                  <p className="text-xs text-text-muted">{t('admin.botTemplates.detail.categoryHint')}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="m-desc">{t('admin.botTemplates.detail.description')}</Label>
                <Textarea id="m-desc" rows={2} value={m.description} onChange={(e) => setMeta({ ...m, description: e.target.value })} />
                <p className="text-xs text-text-muted">{t('admin.botTemplates.detail.descriptionHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Label>Tier</Label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="group" aria-label="Tier">
                  {TIER_OPTIONS.map((tr) => (
                    <button
                      key={tr.id}
                      type="button"
                      aria-pressed={m.tier === tr.id}
                      onClick={() => setMeta({ ...m, tier: tr.id })}
                      className={`rounded-lg border px-3 py-2 text-sm transition-colors ${m.tier === tr.id ? 'border-primary-400 bg-primary-500/10 text-text-primary' : 'border-edge text-text-secondary hover:border-edge-light'}`}
                    >
                      {tr.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-text-muted">Which tier's table this template appears under.</p>
              </div>
            </div>
          </section>

          {/* Distribution */}
          <section className="grid gap-4 border-b border-edge p-5 lg:grid-cols-[220px_1fr] lg:gap-8">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Distribution</h3>
              <p className="mt-1 text-xs text-text-muted">Who can pick this template.</p>
            </div>
            <label
              htmlFor="m-global"
              className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-edge bg-surface-1 p-3 transition-colors hover:border-edge-light"
            >
              <div>
                <div className="text-sm font-medium text-text-primary">{t('admin.botTemplates.create.availableToAll')}</div>
                <p className="mt-0.5 text-xs text-text-muted">{t('admin.botTemplates.detail.availabilityHint')}</p>
              </div>
              <Switch id="m-global" checked={m.availableToAllTenants} onCheckedChange={(v) => setMeta({ ...m, availableToAllTenants: v })} />
            </label>
          </section>

          {/* Save */}
          <div className="flex items-center justify-end gap-3 p-5">
            <Button
              onClick={async () => {
                await updateMut.mutateAsync({ displayName: m.displayName, category: m.category.trim() || null, description: m.description || undefined, tier: m.tier, availableToAllTenants: m.availableToAllTenants });
                setMeta(null);
              }}
              disabled={updateMut.isPending}
            >
              {t('common.save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Current prompt — the live (latest published) system prompt, shown as
          readable prose with its {variables} highlighted as fill-in slots, sized to
          content instead of an empty textarea, with a clear edit path. */}
      <CurrentPromptCard publishedVersion={publishedVersion} onEditNewVersion={openCreate} />

      {/* Versions */}
      <Card variant="glass">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('admin.botTemplates.detail.versions')}</CardTitle>
          <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />{t('admin.botTemplates.actions.newDraft')}</Button>
        </CardHeader>
        <CardContent>
          {versions.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-muted">{t('admin.botTemplates.detail.noVersions')}</p>
          ) : (
            <div className="relative">
              {/* Connecting rail — versions are a timeline; one is Live, the rest are
                  drafts (WIP) or superseded. The dot colour encodes that at a glance. */}
              <div className="absolute bottom-5 left-[9px] top-5 w-px bg-edge" aria-hidden />
              <div className="space-y-1.5">
                {versions.map((v) => {
                  const isLive = v.status === 'published' && v.version === publishedVersion?.version;
                  const dot = isLive
                    ? 'bg-emerald-400'
                    : v.status === 'draft'
                      ? 'bg-amber-400'
                      : v.status === 'published'
                        ? 'bg-text-muted'
                        : 'border border-text-muted bg-surface-1';
                  const label = isLive ? 'Live' : v.status === 'draft' ? 'Draft' : v.status === 'published' ? 'Superseded' : 'Withdrawn';
                  const labelCls = isLive
                    ? 'bg-emerald-500/10 text-emerald-300'
                    : v.status === 'draft'
                      ? 'bg-amber-500/10 text-amber-300'
                      : 'bg-surface-3 text-text-muted';
                  return (
                    <div key={v.id} className="relative flex gap-3">
                      <span className={`relative z-10 mt-[15px] h-[11px] w-[11px] shrink-0 rounded-full ring-4 ring-surface-2 ${dot}`} aria-hidden />
                      <div className={`flex flex-1 items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors ${isLive ? 'border-emerald-500/25 bg-emerald-500/[0.05]' : 'border-edge bg-surface-1'}`}>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-semibold text-text-primary">v{v.version}</span>
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${labelCls}`}>{label}</span>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-text-muted">{v.changelog?.trim() || 'No release notes'}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {v.status === 'draft' ? (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => openEdit(v)}><Pencil className="h-3.5 w-3.5" />{t('common.edit')}</Button>
                              <Button size="sm" onClick={() => publishMut.mutate(v.version)}>{t('admin.botTemplates.actions.publish')}</Button>
                            </>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => openView(v)}><Eye className="h-4 w-4 mr-1" />{t('admin.botTemplates.actions.view')}</Button>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" aria-label={t('admin.botTemplates.versionColumns.actions')}>
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {v.status === 'draft' && (
                                <DropdownMenuItem onClick={() => openEdit(v)}>{t('common.edit')}</DropdownMenuItem>
                              )}
                              {v.status === 'published' && (
                                <DropdownMenuItem
                                  onClick={() =>
                                    withForce(
                                      (force) => unpublishMut.mutateAsync({ version: v.version, force }),
                                      (n) => ({ title: t('admin.botTemplates.confirm.unpublishTitle'), description: t('admin.botTemplates.confirm.reassign', { count: n }) }),
                                    )
                                  }
                                >
                                  {t('admin.botTemplates.actions.unpublish')}
                                </DropdownMenuItem>
                              )}
                              {v.status !== 'draft' && !isLive && (
                                <DropdownMenuItem onClick={() => rollbackMut.mutate(v.version)}>{t('admin.botTemplates.actions.rollback')}</DropdownMenuItem>
                              )}
                              {v.status !== 'published' && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem className="text-red-400 focus:text-red-300" onClick={() => askDelete(v)}>{t('admin.botTemplates.actions.delete')}</DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Grants (only relevant when not globally available) */}
      <GrantsCard
        availableToAllTenants={template.availableToAllTenants}
        tenants={tenants}
        selectedTenantIds={selectedTenantIds}
        tenantName={tenantName}
        onToggleTenant={toggleTenant}
        pickerOpen={tenantPickerOpen}
        onPickerOpenChange={setTenantPickerOpen}
        isSaving={grantsMut.isPending}
        onSave={() =>
          withForce(
            (force) => grantsMut.mutateAsync({ tenantIds: selectedTenantIds, force }).then(() => setSelectedTenants(null)),
            (n) => ({ title: t('admin.botTemplates.confirm.ungrantTitle'), description: t('admin.botTemplates.confirm.reassign', { count: n }) }),
          )
        }
      />

      {/* Version editor — full-page two-pane takeover (author | live ledger).
          Uses the Radix Dialog primitive for focus-trap / Escape / aria-modal / focus
          return; outside-click close is disabled so a stray click can't lose edits. */}
      <DialogPrimitive.Root open={draft.open} onOpenChange={(o) => { if (!o) requestCloseDraft(); }}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content
            aria-label={editorTitle}
            onInteractOutside={(e) => e.preventDefault()}
            className="fixed inset-0 z-50 flex flex-col bg-surface-0 focus:outline-none"
          >
            <DialogPrimitive.Title className="sr-only">{editorTitle}</DialogPrimitive.Title>
            <VersionEditorHeader
              editorTitle={editorTitle}
              mode={draft.mode}
              dirty={dirty}
              category={template.category}
              latestVersion={versions[0]}
              createPending={createVersionMut.isPending}
              editPending={editVersionMut.isPending}
              publishPending={publishMut.isPending}
              onClose={() => setDraft(EMPTY_DRAFT)}
              onCancel={requestCloseDraft}
              onSaveDraft={saveDraft}
              onPublish={publishDraft}
            />
          <div className="flex-1 min-h-0 grid lg:grid-cols-[1fr_minmax(0,440px)]">
            {/* LEFT — author: numbered steps down a connecting rail. */}
            <div className="overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 py-8 lg:px-8">

            {/* 01 — Prompt: the hero, framed as a real editor surface. */}
            <PromptSection
              draft={draft}
              setDraft={setDraft}
              customChips={draftCustomKeys().map((k) => `{${k}}`)}
              onManageVariables={() => setVarsModalOpen(true)}
            />

            {/* 02 — Capabilities: the modules → skills the bot actually gets. */}
            <CapabilitiesSection
              draft={draft}
              setDraft={setDraft}
              skillsCatalog={skillsCatalog}
              moduleCatalog={moduleCatalog}
              customChips={draftCustomKeys().map((k) => `{${k}}`)}
              onManageVariables={() => setVarsModalOpen(true)}
            />

            {/* 03 — Guardrails: template-owned policy (tone stays bot-owned). */}
            <AuthorSection
              step={3}
              icon={ShieldCheck}
              title={t('admin.botTemplates.editor.configTitle')}
              hint={t('admin.botTemplates.editor.configHint')}
            >
              {(() => {
                const ro = draft.mode === 'view';
                const cfg = draft.config;
                const setCfg = (patch: Partial<ConfigDraft>) => setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }));
                const topicsArr = cfg.topicsToAvoid.split(',').map((x) => x.trim()).filter(Boolean);
                const confidence = Number(cfg.confidenceThreshold || DEFAULT_CONFIDENCE);
                const insertMsg = (key: 'greetingMessage' | 'fallbackMessage' | 'offHoursMessage', i18nKey: string) =>
                  setCfg({ [key]: t(i18nKey) } as Partial<ConfigDraft>);
                return (
                  <div className="space-y-5">
                    {/* Customer-facing messages, each with an opt-in "Insert suggested" starter */}
                    <div className="space-y-4 rounded-xl border border-edge bg-surface-1 p-4">
                      {([
                        { key: 'greetingMessage', label: 'greetingMessage', suggest: 'admin.botTemplates.editor.greetingSuggested' },
                        { key: 'fallbackMessage', label: 'fallbackMessage', suggest: 'admin.botTemplates.editor.fallbackSuggested' },
                        { key: 'offHoursMessage', label: 'offHoursMessage', suggest: 'admin.botTemplates.editor.offHoursSuggested' },
                      ] as const).map((f) => (
                        <div key={f.key} className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label htmlFor={`c-${f.key}`}>{t(`admin.botTemplates.editor.${f.label}`)}</Label>
                            {!ro && !cfg[f.key].trim() && (
                              <button type="button" className="text-xs font-medium text-primary-400 hover:text-primary-300" onClick={() => insertMsg(f.key, f.suggest)}>
                                {t('admin.botTemplates.editor.insertSuggested')}
                              </button>
                            )}
                          </div>
                          <Textarea id={`c-${f.key}`} rows={2} value={cfg[f.key]} readOnly={ro} onChange={(e) => setCfg({ [f.key]: e.target.value } as Partial<ConfigDraft>)} />
                        </div>
                      ))}
                    </div>

                    {/* Topics to avoid — chips + one-click common bundle */}
                    <div className="space-y-1.5 rounded-xl border border-edge bg-surface-1 p-4">
                      <div className="flex items-center justify-between">
                        <Label>{t('admin.botTemplates.editor.topicsToAvoid')}</Label>
                        {!ro && (
                          <button type="button" className="text-xs font-medium text-primary-400 hover:text-primary-300" onClick={() => setCfg({ topicsToAvoid: Array.from(new Set([...topicsArr, ...COMMON_TOPICS])).join(', ') })}>
                            {t('admin.botTemplates.editor.topicsAddCommon')}
                          </button>
                        )}
                      </div>
                      <TagInput value={topicsArr} onChange={(arr) => setCfg({ topicsToAvoid: arr.join(', ') })} placeholder={t('admin.botTemplates.editor.topicsPlaceholder')} disabled={ro} />
                      <p className="text-xs text-text-tertiary">{t('admin.botTemplates.editor.topicsHint')}</p>
                    </div>

                    <div className="grid items-start gap-4 sm:grid-cols-2">
                      {/* Confidence — labeled slider */}
                      <div className="space-y-2 rounded-xl border border-edge bg-surface-1 p-4">
                        <div className="flex items-center justify-between">
                          <Label>{t('admin.botTemplates.editor.confidenceThreshold')}</Label>
                          <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs font-medium text-text-primary">{confidence.toFixed(2)}</span>
                        </div>
                        <Slider value={[confidence]} min={0.4} max={0.95} step={0.05} disabled={ro} onValueChange={([v]) => setCfg({ confidenceThreshold: String(v) })} />
                        <div className="flex justify-between text-[10px] text-text-tertiary">
                          <span>{t('admin.botTemplates.editor.confidenceFlexible')}</span>
                          <span>{t('admin.botTemplates.editor.confidenceBalanced')}</span>
                          <span>{t('admin.botTemplates.editor.confidenceStrict')}</span>
                        </div>
                        <p className="text-[10px] text-text-tertiary">{t('admin.botTemplates.editor.confidenceHelper')}</p>
                      </div>

                      {/* Max response length — preset chips + number */}
                      <div className="space-y-2 rounded-xl border border-edge bg-surface-1 p-4">
                        <Label htmlFor="c-maxlen">{t('admin.botTemplates.editor.maxResponseLength')}</Label>
                        {!ro && (
                          <div className="flex flex-wrap gap-1.5">
                            {LENGTH_PRESETS.map((p) => (
                              <Button key={p.value} type="button" variant={cfg.maxResponseLength === p.value ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setCfg({ maxResponseLength: p.value })}>
                                {t(`admin.botTemplates.editor.length.${p.value}`)} <span className="ml-1 opacity-60">{p.words}</span>
                              </Button>
                            ))}
                          </div>
                        )}
                        <Input id="c-maxlen" type="number" step="50" min="1" className="max-w-[140px]" value={cfg.maxResponseLength} readOnly={ro} onChange={(e) => setCfg({ maxResponseLength: e.target.value })} />
                      </div>
                    </div>
                  </div>
                );
              })()}
            </AuthorSection>

            {/* 04 — Version notes: what changed in this draft. */}
            <AuthorSection step={4} icon={Pencil} title={t('admin.botTemplates.editor.changelog')}>
              <Input id="d-changelog" value={draft.changelog} readOnly={draft.mode === 'view'} onChange={(e) => setDraft((d) => ({ ...d, changelog: e.target.value }))} />
            </AuthorSection>

            {/* 05 — Test this prompt: try the current draft (body + config) before publishing. */}
            <TestPromptSection
              log={testLog}
              input={testInput}
              setInput={setTestInput}
              isPending={testChat.isPending}
              onRun={() => void runTest()}
            />

            </div>
            </div>
            {/* RIGHT — live preview: a "monitor" rail. Outcomes first, ledger on demand. */}
            <PreviewRail
              tier={pvTier}
              setTier={setPvTier}
              channel={pvChannel}
              setChannel={setPvChannel}
              isPending={preview.isPending}
              ledger={preview.data}
              selectedSkillIds={draft.selectedSkillIds}
              skillsCatalog={skillsCatalog}
            />
          </div>
    
            {/* Manage all custom template variables — opened from any Insert bar's
                "Manage variables" link. One home for the blanks used across the
                prompt body and every module's prose. */}
            <Dialog open={varsModalOpen} onOpenChange={setVarsModalOpen}>
              <DialogContent className="max-w-xl">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2"><Pencil className="h-4 w-4 text-amber-400" />Template variables</DialogTitle>
                  <DialogDescription>
                    The blanks tenants fill in — any <span className="font-mono text-amber-300">{'{placeholder}'}</span> you use in the prompt or a module’s prose. Tenants complete them when they adopt this template.
                  </DialogDescription>
                </DialogHeader>
                <TooltipProvider delayDuration={150}>
                {(() => {
                  const keys = draftCustomKeys();
                  const getVar = (key: string): TemplateVariable => draft.variables.find((v) => v.key === key) ?? { key };
                  const setVar = (key: string, patch: Partial<TemplateVariable>) =>
                    setDraft((d) => {
                      const has = d.variables.some((v) => v.key === key);
                      const variables = has
                        ? d.variables.map((v) => (v.key === key ? { ...v, ...patch } : v))
                        : [...d.variables, { key, ...patch }];
                      return { ...d, variables };
                    });
                  const cleanKey = newVarName.trim().replace(/[^\w]/g, '');
                  const addVar = () => {
                    if (!cleanKey || keys.includes(cleanKey)) { setNewVarName(''); return; }
                    setDraft((d) => ({ ...d, body: d.body + (d.body && !/\s$/.test(d.body) ? ' ' : '') + `{${cleanKey}}` }));
                    setNewVarName('');
                  };
                  return (
                    <div className="space-y-2.5">
                      <div className="max-h-[55vh] space-y-2.5 overflow-y-auto pr-0.5">
                        {keys.length === 0 ? (
                          <p className="rounded-lg border border-dashed border-edge bg-surface-0/50 px-3 py-4 text-xs text-text-muted">
                            No custom variables yet. Type a <span className="font-mono text-amber-300">{'{placeholder}'}</span> into the prompt or a module’s prose, or add one below.
                          </p>
                        ) : (
                          keys.map((key) => {
                            const v = getVar(key);
                            return (
                              <div key={key} className="space-y-2.5 rounded-lg border border-edge bg-surface-0/50 p-3">
                                <div className="flex items-center gap-2">
                                  <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-xs text-amber-300 ring-1 ring-inset ring-amber-500/20">{`{${key}}`}</span>
                                  <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-text-muted">
                                    <Switch checked={v.required ?? false} onCheckedChange={(c) => setVar(key, { required: c })} />
                                    <FieldHint label="Required" tip="Tenants must fill this in before they can finish setting up their bot. Leave off if it's optional." />
                                  </label>
                                </div>
                                <div className="grid gap-x-2 gap-y-0 sm:grid-cols-2">
                                  <div>
                                    <FieldHint label="Label" tip="The friendly name tenants see for this blank instead of the raw {key} — e.g. 'Cancellation policy'." />
                                    <Input value={v.label ?? ''} placeholder={prettifyKey(key)} onChange={(e) => setVar(key, { label: e.target.value })} className="h-8 text-xs" />
                                  </div>
                                  <div>
                                    <FieldHint label="Default value" tip="Pre-fills the blank if the tenant leaves it empty. Leave blank to make them enter their own." />
                                    <Input value={v.default ?? ''} placeholder="Optional" onChange={(e) => setVar(key, { default: e.target.value })} className="h-8 text-xs" />
                                  </div>
                                </div>
                                <div>
                                  <FieldHint label="Help text" tip="A short hint shown to the tenant under this field, telling them what to enter." />
                                  <Input value={v.help ?? ''} placeholder="Optional — shown to tenants" onChange={(e) => setVar(key, { help: e.target.value })} className="h-8 text-xs" />
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 border-t border-edge/60 pt-3">
                        <span className="shrink-0 text-xs text-text-muted">Add variable</span>
                        <div className="relative flex-1">
                          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-xs text-text-muted">{'{'}</span>
                          <Input
                            value={newVarName}
                            onChange={(e) => setNewVarName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addVar(); } }}
                            placeholder="cancellationPolicy"
                            className="h-8 px-5 font-mono text-xs"
                          />
                          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-xs text-text-muted">{'}'}</span>
                        </div>
                        <Button type="button" size="sm" variant="outline" disabled={!cleanKey} onClick={addVar}>
                          <Plus className="h-3.5 w-3.5" />Add
                        </Button>
                      </div>
                    </div>
                  );
                })()}
                </TooltipProvider>
                <DialogFooter>
                  <Button size="sm" onClick={() => setVarsModalOpen(false)}>Done</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

      </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Force-confirm dialog */}
      <AlertDialog open={confirm.open} onOpenChange={(o) => setConfirm((c) => ({ ...c, open: o }))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirm.onConfirm}>{t('admin.botTemplates.confirm.proceed')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </div>
  );
};

export default AdminBotTemplateDetail;
