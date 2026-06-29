/**
 * Super-admin Bot Template editor (.scratch/plan-bot-templates.md, Phase 3b):
 * metadata + versions (draft/publish/unpublish/rollback) + per-tenant grants.
 *
 * Destructive ops (archive, unpublish a pinned version, removing a grant from a
 * tenant with bound bots) use a confirm-then-force flow: try without force →
 * the API answers 409 with an impacted count → confirm → retry with force,
 * which reassigns affected bots to blank-base (T21).
 */
import React, { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Check, X, ChevronsUpDown, Eye, MoreVertical } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import TagInput from '@/pages/knowledge/TagInput';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { useAdminTenantsAll } from '@/queries/useAdminQueries';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useAdminBotTemplateDetail, useUpdateBotTemplate, useArchiveBotTemplate,
  useCreateTemplateVersion, useEditTemplateVersion, usePublishTemplateVersion,
  useUnpublishTemplateVersion, useDeleteTemplateVersion, useRollbackTemplate, useUpdateTemplateGrants, useTemplateTestChat,
  usePreviewLedger,
  forceConflict, type BotTemplateVersion, type BotTemplateConfig,
} from '../../queries/useBotTemplatesQueries';

// Platform defaults — seeded as REAL values in the editor (not grey placeholders)
// so an author always sees the effective template, per the UX review.
const DEFAULT_CONFIDENCE = '0.7';
const DEFAULT_MAX_LENGTH = '500';

// Max-response-length presets (chars) with rough word estimates shown in the UI.
const LENGTH_PRESETS = [
  { value: '300', words: '~45–60 words' },
  { value: '500', words: '~75–100 words' },
  { value: '900', words: '~130–170 words' },
  { value: '1200', words: '~180–230 words' },
] as const;
// One-click safety bundle for "topics to avoid".
const COMMON_TOPICS = ['politics', 'religion', 'adult content', 'illegal activity', 'hate or harassment', 'self-harm', 'legal advice', 'medical diagnosis', 'financial advice'];

// Policy guardrails are edited as flat strings in the dialog, then assembled into
// a BotTemplateConfig on save. Confidence/max-length carry real defaults; messages
// + topics stay empty (opt-in via "Insert suggested"). Tone is bot-owned, not here.
type ConfigDraft = {
  topicsToAvoid: string;
  greetingMessage: string;
  fallbackMessage: string;
  offHoursMessage: string;
  confidenceThreshold: string;
  maxResponseLength: string;
};
const EMPTY_CONFIG: ConfigDraft = {
  topicsToAvoid: '', greetingMessage: '', fallbackMessage: '', offHoursMessage: '', confidenceThreshold: DEFAULT_CONFIDENCE, maxResponseLength: DEFAULT_MAX_LENGTH,
};

function configToDraft(c: BotTemplateConfig | undefined): ConfigDraft {
  const g = c?.guardrails ?? {};
  return {
    topicsToAvoid: (g.topicsToAvoid ?? []).join(', '),
    greetingMessage: g.greetingMessage ?? '',
    fallbackMessage: g.fallbackMessage ?? '',
    offHoursMessage: g.offHoursMessage ?? '',
    confidenceThreshold: g.confidenceThreshold === undefined ? DEFAULT_CONFIDENCE : String(g.confidenceThreshold),
    maxResponseLength: g.maxResponseLength === undefined ? DEFAULT_MAX_LENGTH : String(g.maxResponseLength),
  };
}

function draftToConfig(d: ConfigDraft): BotTemplateConfig {
  const config: BotTemplateConfig = {};
  const g: NonNullable<BotTemplateConfig['guardrails']> = {};
  const topics = d.topicsToAvoid.split(',').map((x) => x.trim()).filter(Boolean);
  if (topics.length) g.topicsToAvoid = topics;
  if (d.greetingMessage.trim()) g.greetingMessage = d.greetingMessage;
  if (d.fallbackMessage.trim()) g.fallbackMessage = d.fallbackMessage;
  if (d.offHoursMessage.trim()) g.offHoursMessage = d.offHoursMessage;
  if (d.confidenceThreshold.trim()) g.confidenceThreshold = Number(d.confidenceThreshold);
  if (d.maxResponseLength.trim()) g.maxResponseLength = Number(d.maxResponseLength);
  if (Object.keys(g).length) config.guardrails = g;
  return config;
}

// Canonical {placeholder} set (mirrors the API's KNOWN_PLACEHOLDERS) for live linting.
const KNOWN_PLACEHOLDERS = new Set(['botName', 'tone', 'supportEmail', 'businessName', 'fallbackMessage', 'offHoursMessage', 'greetingMessage', 'maxResponseLength', 'topicsToAvoid']);
function unknownPlaceholders(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\{(\w+)\}/g)) if (!KNOWN_PLACEHOLDERS.has(m[1])) out.add(m[1]);
  return [...out];
}

/** Count the guardrail fields a template actually sets (for the current-prompt summary). */
function countGuardrails(c: BotTemplateConfig): number {
  const g = c.guardrails ?? {};
  let n = 0;
  if (g.greetingMessage) n++;
  if (g.fallbackMessage) n++;
  if (g.offHoursMessage) n++;
  if (g.topicsToAvoid?.length) n++;
  if (g.confidenceThreshold !== undefined) n++;
  if (g.maxResponseLength !== undefined) n++;
  return n;
}

type VersionDraft = { open: boolean; mode: 'create' | 'edit' | 'view'; version?: number; lockVersion?: number; body: string; changelog: string; expectedModules: string; config: ConfigDraft };
const EMPTY_DRAFT: VersionDraft = { open: false, mode: 'create', body: '', changelog: '', expectedModules: '', config: EMPTY_CONFIG };

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
  const draftBaselineRef = useRef<string>('');

  const [meta, setMeta] = useState<{ displayName: string; description: string; availableToAllTenants: boolean } | null>(null);
  const [draft, setDraft] = useState<VersionDraft>(EMPTY_DRAFT);
  const [testInput, setTestInput] = useState('');
  const [testLog, setTestLog] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [selectedTenants, setSelectedTenants] = useState<string[] | null>(null);
  const [tenantPickerOpen, setTenantPickerOpen] = useState(false);
  const [pvTier, setPvTier] = useState<'free' | 'essential' | 'pro' | 'enterprise'>('pro');
  const [pvChannel, setPvChannel] = useState('widget');
  const [pvBooking, setPvBooking] = useState(false);
  const [confirm, setConfirm] = useState<{ open: boolean; title: string; description: string; onConfirm: () => void }>({
    open: false, title: '', description: '', onConfirm: () => {},
  });

  if (isLoading) return <PageSkeleton variant="list" rows={4} />;
  if (isError || !data) return <InlineError message={t('admin.botTemplates.errors.load')} />;

  const { template, versions, grantedTenantIds, usage, moduleCatalog } = data;
  // The live prompt = latest published version (versions are DESC-ordered).
  const publishedVersion = versions.find((v) => v.status === 'published');
  const m = meta ?? {
    displayName: template.displayName,
    description: template.description ?? '',
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
  const draftKey = (d: VersionDraft) => JSON.stringify({ body: d.body, changelog: d.changelog, expectedModules: d.expectedModules, config: d.config });
  const openDraft = (d: VersionDraft) => { draftBaselineRef.current = draftKey(d); setTestLog([]); setTestInput(''); setDraft(d); };

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

  // L10/Phase 4: compile the current draft under a mock runtime context and show the
  // block ledger (which blocks would be included/excluded, and why). No LLM call.
  // (preview/pv* hooks are declared at the top with the other hooks — before the
  // loading early-return — to keep hook order stable.)
  const runPreview = () =>
    preview.mutate({
      body: draft.body,
      config: draftToConfig(draft.config),
      tier: pvTier,
      channel: pvChannel,
      activeModules: pvBooking ? ['booking'] : [],
    });

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
  const openCreate = () => {
    const latest = versions[0];
    openDraft({
      ...EMPTY_DRAFT,
      open: true,
      mode: 'create',
      body: latest?.body ?? '',
      expectedModules: latest ? latest.expectedModules.join(', ') : '',
      config: latest ? configToDraft(latest.config) : EMPTY_CONFIG,
    });
  };
  const openEdit = (v: BotTemplateVersion) =>
    openDraft({ open: true, mode: 'edit', version: v.version, lockVersion: v.lockVersion, body: v.body, changelog: v.changelog ?? '', expectedModules: v.expectedModules.join(', '), config: configToDraft(v.config) });
  const openView = (v: BotTemplateVersion) =>
    openDraft({ open: true, mode: 'view', version: v.version, body: v.body, changelog: v.changelog ?? '', expectedModules: v.expectedModules.join(', '), config: configToDraft(v.config) });

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

  const saveDraft = async () => {
    const config = draftToConfig(draft.config);
    if (draft.mode === 'create') {
      await createVersionMut.mutateAsync({ body: draft.body, changelog: draft.changelog || null, expectedModules: parseModules(draft.expectedModules), config });
    } else {
      await editVersionMut.mutateAsync({ version: draft.version!, lockVersion: draft.lockVersion!, body: draft.body, changelog: draft.changelog || null, expectedModules: parseModules(draft.expectedModules), config });
    }
    setDraft(EMPTY_DRAFT);
  };

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div>
        <Link to="/admin/bot-templates" className="inline-flex items-center text-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t('admin.botTemplates.detail.back')}
        </Link>
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-text-primary">{template.displayName}</h1>
            <Badge variant={template.status === 'active' ? 'default' : 'secondary'}>
              {t(`admin.botTemplates.templateStatus.${template.status}`)}
            </Badge>
            <span className="text-xs font-mono text-text-tertiary">{template.key}</span>
            <Badge variant="secondary">{t('admin.botTemplates.detail.usage', { bots: usage.bots, tenants: usage.tenants })}</Badge>
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

      {/* Metadata */}
      <Card variant="glass">
        <CardHeader><CardTitle>{t('admin.botTemplates.detail.metadata')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="m-name">{t('admin.botTemplates.create.displayName')}</Label>
            <Input id="m-name" value={m.displayName} onChange={(e) => setMeta({ ...m, displayName: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="m-desc">{t('admin.botTemplates.detail.description')}</Label>
            <Textarea id="m-desc" rows={2} value={m.description} onChange={(e) => setMeta({ ...m, description: e.target.value })} />
            <p className="text-xs text-text-tertiary">{t('admin.botTemplates.detail.descriptionHint')}</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="m-global">{t('admin.botTemplates.create.availableToAll')}</Label>
              <p className="text-xs text-text-tertiary">{t('admin.botTemplates.detail.availabilityHint')}</p>
            </div>
            <Switch id="m-global" checked={m.availableToAllTenants} onCheckedChange={(v) => setMeta({ ...m, availableToAllTenants: v })} />
          </div>
          <div className="flex justify-end">
            <Button
              onClick={async () => {
                await updateMut.mutateAsync({ displayName: m.displayName, description: m.description || undefined, availableToAllTenants: m.availableToAllTenants });
                setMeta(null);
              }}
              disabled={updateMut.isPending}
            >
              {t('common.save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Current prompt — the live (latest published) prompt, surfaced so you can
          see what the bot does without opening a version, with a clear edit path. */}
      <Card variant="glass">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CardTitle>{t('admin.botTemplates.detail.currentPrompt')}</CardTitle>
            {publishedVersion && <Badge variant="default">{`v${publishedVersion.version}`}</Badge>}
          </div>
          <Button size="sm" onClick={() => openCreate()}>{t('admin.botTemplates.actions.editNewVersion')}</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {publishedVersion ? (
            <>
              <Textarea
                readOnly
                rows={8}
                value={publishedVersion.body || ''}
                placeholder={t('admin.botTemplates.detail.promptEmpty')}
                className="font-mono text-xs bg-surface-2"
              />
              <p className="text-xs text-text-tertiary">
                {countGuardrails(publishedVersion.config) === 0
                  ? t('admin.botTemplates.detail.promptConfigDefaults')
                  : t('admin.botTemplates.detail.promptConfigSummary', { count: countGuardrails(publishedVersion.config) })}
              </p>
            </>
          ) : (
            <p className="text-sm text-text-tertiary">{t('admin.botTemplates.detail.noPublishedPrompt')}</p>
          )}
        </CardContent>
      </Card>

      {/* Versions */}
      <Card variant="glass">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('admin.botTemplates.detail.versions')}</CardTitle>
          <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />{t('admin.botTemplates.actions.newDraft')}</Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.botTemplates.versionColumns.version')}</TableHead>
                <TableHead>{t('admin.botTemplates.versionColumns.status')}</TableHead>
                <TableHead>{t('admin.botTemplates.versionColumns.changelog')}</TableHead>
                <TableHead className="text-right">{t('admin.botTemplates.versionColumns.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-medium">v{v.version}</TableCell>
                  <TableCell>
                    <Badge variant={v.status === 'published' ? 'default' : v.status === 'draft' ? 'outline' : 'secondary'}>
                      {t(`admin.botTemplates.versionStatus.${v.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-text-secondary max-w-xs truncate">{v.changelog ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* Primary action stays visible; the rest live in the ⋯ menu. */}
                      {v.status === 'draft' ? (
                        <Button size="sm" onClick={() => publishMut.mutate(v.version)}>{t('admin.botTemplates.actions.publish')}</Button>
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
                          {v.status !== 'draft' && (
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
                  </TableCell>
                </TableRow>
              ))}
              {versions.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-sm text-text-tertiary py-6">{t('admin.botTemplates.detail.noVersions')}</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Grants (only relevant when not globally available) */}
      <Card variant="glass">
        <CardHeader><CardTitle>{t('admin.botTemplates.detail.grants')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-text-tertiary">
            {template.availableToAllTenants ? t('admin.botTemplates.detail.grantsGlobalHint') : t('admin.botTemplates.detail.grantsHint')}
          </p>

          {!template.availableToAllTenants && (
            <>
              {/* Searchable tenant multi-select */}
              <Popover open={tenantPickerOpen} onOpenChange={setTenantPickerOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" className="w-full justify-between">
                    {selectedTenantIds.length
                      ? t('admin.botTemplates.detail.tenantsSelected', { count: selectedTenantIds.length })
                      : t('admin.botTemplates.detail.tenantsSelectPlaceholder')}
                    <ChevronsUpDown className="h-4 w-4 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command>
                    <CommandInput placeholder={t('admin.botTemplates.detail.tenantsSearch')} />
                    <CommandList>
                      <CommandEmpty>{t('admin.botTemplates.detail.tenantsNone')}</CommandEmpty>
                      <CommandGroup>
                        {tenants.map((tenant) => {
                          const checked = selectedTenantIds.includes(tenant.id);
                          return (
                            <CommandItem key={tenant.id} value={`${tenant.name} ${tenant.id}`} onSelect={() => toggleTenant(tenant.id)}>
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
                      <button type="button" onClick={() => toggleTenant(tid)} aria-label="remove">
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  variant="outline"
                  disabled={grantsMut.isPending}
                  onClick={() =>
                    withForce(
                      (force) => grantsMut.mutateAsync({ tenantIds: selectedTenantIds, force }).then(() => setSelectedTenants(null)),
                      (n) => ({ title: t('admin.botTemplates.confirm.ungrantTitle'), description: t('admin.botTemplates.confirm.reassign', { count: n }) }),
                    )
                  }
                >
                  {t('admin.botTemplates.actions.saveAccess')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Version editor dialog */}
      <Dialog open={draft.open} onOpenChange={(o) => { if (!o) requestCloseDraft(); else setDraft((d) => ({ ...d, open: o })); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {draft.mode === 'create'
                ? t('admin.botTemplates.editor.newTitle')
                : draft.mode === 'view'
                  ? t('admin.botTemplates.editor.viewTitle', { version: draft.version })
                  : t('admin.botTemplates.editor.editTitle', { version: draft.version })}
            </DialogTitle>
            {draft.mode === 'create' && versions[0] && (
              <p className="text-xs text-text-tertiary">{t('admin.botTemplates.editor.prefilledFrom', { version: versions[0].version })}</p>
            )}
          </DialogHeader>
          <div className="space-y-4 overflow-y-auto flex-1 -mx-1 px-1">
            <div className="space-y-1.5">
              <Label htmlFor="d-body">{t('admin.botTemplates.editor.body')}</Label>
              <Textarea id="d-body" rows={12} className="font-mono text-sm" value={draft.body} readOnly={draft.mode === 'view'} onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} />
              {draft.mode !== 'view' && <p className="text-xs text-text-tertiary">{t('admin.botTemplates.editor.bodyHint')}</p>}
              {draft.mode !== 'view' && unknownPlaceholders(draft.body).length > 0 && (
                <p className="text-xs text-amber-400">
                  {t('admin.botTemplates.editor.unknownPlaceholders', { placeholders: unknownPlaceholders(draft.body).map((p) => `{${p}}`).join(', ') })}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>{t('admin.botTemplates.editor.expectedModules')}</Label>
              {(() => {
                const ro = draft.mode === 'view';
                const modulesArr = draft.expectedModules.split(',').map((x) => x.trim()).filter(Boolean);
                const toggleModule = (mid: string) => {
                  const next = modulesArr.includes(mid) ? modulesArr.filter((x) => x !== mid) : [...modulesArr, mid];
                  setDraft((d) => ({ ...d, expectedModules: next.join(', ') }));
                };
                if (moduleCatalog.length === 0) return <p className="text-xs text-text-tertiary">{t('admin.botTemplates.editor.noModules')}</p>;
                return (
                  <div className="flex flex-wrap gap-1.5">
                    {moduleCatalog.map((mod) => {
                      const selected = modulesArr.includes(mod.id);
                      return (
                        <Button key={mod.id} type="button" size="sm" variant={selected ? 'default' : 'outline'} className="h-7 text-xs" disabled={ro} onClick={() => toggleModule(mod.id)}>
                          {selected && <Check className="h-3 w-3 mr-1" />}{mod.displayName}
                        </Button>
                      );
                    })}
                  </div>
                );
              })()}
              <p className="text-xs text-text-tertiary">{t('admin.botTemplates.editor.expectedModulesHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="d-changelog">{t('admin.botTemplates.editor.changelog')}</Label>
              <Input id="d-changelog" value={draft.changelog} readOnly={draft.mode === 'view'} onChange={(e) => setDraft((d) => ({ ...d, changelog: e.target.value }))} />
            </div>

            {/* Template-owned policy guardrails (admin-controlled). Tone is bot-owned. */}
            {(() => {
              const ro = draft.mode === 'view';
              const cfg = draft.config;
              const setCfg = (patch: Partial<ConfigDraft>) => setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }));
              const topicsArr = cfg.topicsToAvoid.split(',').map((x) => x.trim()).filter(Boolean);
              const confidence = Number(cfg.confidenceThreshold || DEFAULT_CONFIDENCE);
              const insertMsg = (key: 'greetingMessage' | 'fallbackMessage' | 'offHoursMessage', i18nKey: string) =>
                setCfg({ [key]: t(i18nKey) } as Partial<ConfigDraft>);
              return (
                <div className="border-t border-border/50 pt-4 space-y-4">
                  <div>
                    <h4 className="text-sm font-medium text-text-primary">{t('admin.botTemplates.editor.configTitle')}</h4>
                    <p className="text-xs text-text-tertiary">{t('admin.botTemplates.editor.configHint')}</p>
                  </div>

                  {/* Customer-facing messages, each with an opt-in "Insert suggested" starter */}
                  {([
                    { key: 'greetingMessage', label: 'greetingMessage', suggest: 'admin.botTemplates.editor.greetingSuggested' },
                    { key: 'fallbackMessage', label: 'fallbackMessage', suggest: 'admin.botTemplates.editor.fallbackSuggested' },
                    { key: 'offHoursMessage', label: 'offHoursMessage', suggest: 'admin.botTemplates.editor.offHoursSuggested' },
                  ] as const).map((f) => (
                    <div key={f.key} className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label htmlFor={`c-${f.key}`}>{t(`admin.botTemplates.editor.${f.label}`)}</Label>
                        {!ro && !cfg[f.key].trim() && (
                          <button type="button" className="text-xs text-primary-400 hover:text-primary-300" onClick={() => insertMsg(f.key, f.suggest)}>
                            {t('admin.botTemplates.editor.insertSuggested')}
                          </button>
                        )}
                      </div>
                      <Textarea id={`c-${f.key}`} rows={2} value={cfg[f.key]} readOnly={ro} onChange={(e) => setCfg({ [f.key]: e.target.value } as Partial<ConfigDraft>)} />
                    </div>
                  ))}

                  {/* Topics to avoid — chips + one-click common bundle */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label>{t('admin.botTemplates.editor.topicsToAvoid')}</Label>
                      {!ro && (
                        <button type="button" className="text-xs text-primary-400 hover:text-primary-300" onClick={() => setCfg({ topicsToAvoid: Array.from(new Set([...topicsArr, ...COMMON_TOPICS])).join(', ') })}>
                          {t('admin.botTemplates.editor.topicsAddCommon')}
                        </button>
                      )}
                    </div>
                    <TagInput value={topicsArr} onChange={(arr) => setCfg({ topicsToAvoid: arr.join(', ') })} placeholder={t('admin.botTemplates.editor.topicsPlaceholder')} disabled={ro} />
                    <p className="text-xs text-text-tertiary">{t('admin.botTemplates.editor.topicsHint')}</p>
                  </div>

                  {/* Confidence — labeled slider */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>{t('admin.botTemplates.editor.confidenceThreshold')}</Label>
                      <span className="text-xs font-medium text-text-secondary">{confidence.toFixed(2)}</span>
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
                  <div className="space-y-1.5">
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
              );
            })()}

            {/* Test this prompt — try the current draft (body + config) before publishing. */}
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="test" className="rounded-xl border border-edge px-4 border-b">
                <AccordionTrigger className="hover:no-underline text-sm font-medium">{t('admin.botTemplates.editor.testTitle')}</AccordionTrigger>
                <AccordionContent className="space-y-3">
                  {testLog.length > 0 && (
                    <div className="max-h-48 overflow-y-auto space-y-2 rounded-lg bg-surface-2 p-2">
                      {testLog.map((mtest, i) => (
                        <div key={i} className={mtest.role === 'user' ? 'text-right' : 'text-left'}>
                          <span className={`inline-block rounded-lg px-2.5 py-1.5 text-xs ${mtest.role === 'user' ? 'bg-primary-600 text-white' : 'bg-surface-3 text-text-primary'}`}>
                            {mtest.content}
                          </span>
                        </div>
                      ))}
                      {testChat.isPending && <p className="text-xs text-text-tertiary">{t('admin.botTemplates.editor.testThinking')}</p>}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Input
                      value={testInput}
                      placeholder={t('admin.botTemplates.editor.testPlaceholder')}
                      onChange={(e) => setTestInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void runTest(); } }}
                    />
                    <Button type="button" onClick={() => void runTest()} disabled={testChat.isPending || !testInput.trim()}>
                      {t('admin.botTemplates.editor.testSend')}
                    </Button>
                  </div>
                  <p className="text-[10px] text-text-tertiary">{t('admin.botTemplates.editor.testHint')}</p>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            {/* Preview the compiled prompt's block ledger under a mock runtime context
                (tier / channel / modules). Internal superadmin tool — labels are literal. */}
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="ledger" className="rounded-xl border border-edge px-4 border-b">
                <AccordionTrigger className="hover:no-underline text-sm font-medium">Preview block ledger (mock context)</AccordionTrigger>
                <AccordionContent className="space-y-3 text-xs">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1">Tier
                      <select className="rounded border border-edge bg-surface-2 px-1 py-0.5" value={pvTier} onChange={(e) => setPvTier(e.target.value as typeof pvTier)}>
                        <option value="free">free</option><option value="essential">essential</option><option value="pro">pro</option><option value="enterprise">enterprise</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1">Channel
                      <select className="rounded border border-edge bg-surface-2 px-1 py-0.5" value={pvChannel} onChange={(e) => setPvChannel(e.target.value)}>
                        <option value="widget">widget</option><option value="whatsapp">whatsapp</option><option value="instagram">instagram</option><option value="messenger">messenger</option><option value="telegram">telegram</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1"><input type="checkbox" checked={pvBooking} onChange={(e) => setPvBooking(e.target.checked)} /> booking active</label>
                    <Button type="button" size="sm" disabled={preview.isPending} onClick={() => runPreview()}>Preview</Button>
                  </div>
                  {preview.data && (
                    <div className="space-y-1.5">
                      <div><span className="font-medium">Included:</span>{' '}
                        {preview.data.includedBlocks.map((b) => (
                          <span key={b} className="mr-1 inline-block rounded bg-surface-3 px-1.5 py-0.5 text-text-primary">{b}</span>
                        ))}
                      </div>
                      <div><span className="font-medium">Excluded:</span>{' '}
                        {preview.data.excludedBlocks.map((e) => (
                          <span key={e.key} className="mr-1 inline-block rounded bg-surface-2 px-1.5 py-0.5 text-text-tertiary">{e.key} <span className="opacity-60">({e.reason})</span></span>
                        ))}
                      </div>
                      <div><span className="font-medium">Allowed tools:</span> {preview.data.allowedTools.join(', ') || '—'}</div>
                      <p className="text-[10px] text-warning-600">{preview.data.caveat}</p>
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
          <DialogFooter className="shrink-0 pt-2">
            {draft.mode === 'view' ? (
              <Button variant="outline" onClick={() => setDraft(EMPTY_DRAFT)}>{t('common.close')}</Button>
            ) : (
              <>
                <Button variant="outline" onClick={requestCloseDraft}>{t('common.cancel')}</Button>
                <Button onClick={saveDraft} disabled={createVersionMut.isPending || editVersionMut.isPending}>{t('admin.botTemplates.editor.saveDraft')}</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
  );
};

export default AdminBotTemplateDetail;
