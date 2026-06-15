/**
 * Super-admin Bot Template editor (.scratch/plan-bot-templates.md, Phase 3b):
 * metadata + versions (draft/publish/unpublish/rollback) + per-tenant grants.
 *
 * Destructive ops (archive, unpublish a pinned version, removing a grant from a
 * tenant with bound bots) use a confirm-then-force flow: try without force →
 * the API answers 409 with an impacted count → confirm → retry with force,
 * which reassigns affected bots to blank-base (T21).
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Check, X, ChevronsUpDown } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
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
  useUnpublishTemplateVersion, useRollbackTemplate, useUpdateTemplateGrants,
  forceConflict, type BotTemplateVersion,
} from '../../queries/useBotTemplatesQueries';

type VersionDraft = { open: boolean; mode: 'create' | 'edit'; version?: number; lockVersion?: number; body: string; changelog: string; expectedModules: string };
const EMPTY_DRAFT: VersionDraft = { open: false, mode: 'create', body: '', changelog: '', expectedModules: '' };

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
  const rollbackMut = useRollbackTemplate(id);
  const grantsMut = useUpdateTemplateGrants(id);

  const [meta, setMeta] = useState<{ displayName: string; category: string; description: string; availableToAllTenants: boolean } | null>(null);
  const [draft, setDraft] = useState<VersionDraft>(EMPTY_DRAFT);
  const [selectedTenants, setSelectedTenants] = useState<string[] | null>(null);
  const [tenantPickerOpen, setTenantPickerOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ open: boolean; title: string; description: string; onConfirm: () => void }>({
    open: false, title: '', description: '', onConfirm: () => {},
  });

  if (isLoading) return <PageSkeleton variant="list" rows={4} />;
  if (isError || !data) return <InlineError message={t('admin.botTemplates.errors.load')} />;

  const { template, versions, grantedTenantIds } = data;
  const m = meta ?? {
    displayName: template.displayName,
    category: template.category ?? '',
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

  const openCreate = () => setDraft({ ...EMPTY_DRAFT, open: true, mode: 'create' });
  const openEdit = (v: BotTemplateVersion) =>
    setDraft({ open: true, mode: 'edit', version: v.version, lockVersion: v.lockVersion, body: v.body, changelog: v.changelog ?? '', expectedModules: v.expectedModules.join(', ') });

  const saveDraft = async () => {
    if (draft.mode === 'create') {
      await createVersionMut.mutateAsync({ body: draft.body, changelog: draft.changelog || null, expectedModules: parseModules(draft.expectedModules) });
    } else {
      await editVersionMut.mutateAsync({ version: draft.version!, lockVersion: draft.lockVersion!, body: draft.body, changelog: draft.changelog || null, expectedModules: parseModules(draft.expectedModules) });
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
            <Label htmlFor="m-cat">{t('admin.botTemplates.create.category')}</Label>
            <Input id="m-cat" value={m.category} onChange={(e) => setMeta({ ...m, category: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="m-desc">{t('admin.botTemplates.detail.description')}</Label>
            <Textarea id="m-desc" rows={2} value={m.description} onChange={(e) => setMeta({ ...m, description: e.target.value })} />
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
                await updateMut.mutateAsync({ displayName: m.displayName, category: m.category || undefined, description: m.description || undefined, availableToAllTenants: m.availableToAllTenants });
                setMeta(null);
              }}
              disabled={updateMut.isPending}
            >
              {t('common.save')}
            </Button>
          </div>
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
                  <TableCell className="text-right space-x-2">
                    {v.status === 'draft' && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(v)}>{t('common.edit')}</Button>
                        <Button size="sm" onClick={() => publishMut.mutate(v.version)}>{t('admin.botTemplates.actions.publish')}</Button>
                      </>
                    )}
                    {v.status === 'published' && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => rollbackMut.mutate(v.version)}>{t('admin.botTemplates.actions.rollback')}</Button>
                        <Button
                          size="sm" variant="ghost"
                          onClick={() =>
                            withForce(
                              (force) => unpublishMut.mutateAsync({ version: v.version, force }),
                              (n) => ({ title: t('admin.botTemplates.confirm.unpublishTitle'), description: t('admin.botTemplates.confirm.reassign', { count: n }) }),
                            )
                          }
                        >
                          {t('admin.botTemplates.actions.unpublish')}
                        </Button>
                      </>
                    )}
                    {v.status === 'unpublished' && (
                      <Button size="sm" variant="ghost" onClick={() => rollbackMut.mutate(v.version)}>{t('admin.botTemplates.actions.rollback')}</Button>
                    )}
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
      <Dialog open={draft.open} onOpenChange={(o) => setDraft((d) => ({ ...d, open: o }))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {draft.mode === 'create' ? t('admin.botTemplates.editor.newTitle') : t('admin.botTemplates.editor.editTitle', { version: draft.version })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="d-body">{t('admin.botTemplates.editor.body')}</Label>
              <Textarea id="d-body" rows={12} className="font-mono text-sm" value={draft.body} onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} />
              <p className="text-xs text-text-tertiary">{t('admin.botTemplates.editor.bodyHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="d-modules">{t('admin.botTemplates.editor.expectedModules')}</Label>
              <Input id="d-modules" value={draft.expectedModules} placeholder="booking" onChange={(e) => setDraft((d) => ({ ...d, expectedModules: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="d-changelog">{t('admin.botTemplates.editor.changelog')}</Label>
              <Input id="d-changelog" value={draft.changelog} onChange={(e) => setDraft((d) => ({ ...d, changelog: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(EMPTY_DRAFT)}>{t('common.cancel')}</Button>
            <Button onClick={saveDraft} disabled={createVersionMut.isPending || editVersionMut.isPending}>{t('common.save')}</Button>
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
