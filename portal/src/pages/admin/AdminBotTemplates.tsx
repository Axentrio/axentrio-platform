/**
 * Super-admin Bot Templates — a tiered catalogue (Essential / Pro / Enterprise),
 * each tier its own table with its own templates (they do not cross over).
 * Editor lives in AdminBotTemplateDetail.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, FileText, CircleCheck, TriangleAlert } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useAdminBotTemplates, useCreateBotTemplate, useUnavailableTemplates, type BotTemplateSummary, type TemplateTier } from '../../queries/useBotTemplatesQueries';

/**
 * The tiers are an ascending ladder, so the page climbs it: the left rail
 * intensifies with value — a quiet neutral bar at Essential, solid indigo at
 * Pro, an indigo→violet gradient at the Enterprise summit. Tables stay identical
 * and quiet; the tier identity lives entirely in the rail + header.
 */
const TIERS: { id: TemplateTier; label: string; blurb: string; rail: string; chip: string }[] = [
  { id: 'essential', label: 'Essential', blurb: 'Entry tier — the baseline catalogue.', rail: 'bg-edge-light', chip: 'border-edge text-text-secondary' },
  { id: 'pro', label: 'Pro', blurb: 'Mid tier — for growing teams.', rail: 'bg-primary-500', chip: 'border-primary-500/40 bg-primary-500/10 text-primary-300' },
  { id: 'enterprise', label: 'Enterprise', blurb: 'Top tier — full-capability templates.', rail: 'bg-gradient-to-b from-primary-400 to-violet-500', chip: 'border-violet-500/40 bg-violet-500/10 text-violet-300' },
];

const AdminBotTemplates: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: templates, isLoading, isError } = useAdminBotTemplates();
  const createMut = useCreateBotTemplate();
  const health = useUnavailableTemplates();
  const strandedBots = health.data?.bots ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<{ key: string; displayName: string; category: string; description: string; tier: TemplateTier; availableToAllTenants: boolean }>({
    key: '', displayName: '', category: '', description: '', tier: 'essential', availableToAllTenants: false,
  });

  const openCreate = (tier: TemplateTier) => {
    setForm((f) => ({ ...f, tier }));
    setCreateOpen(true);
  };

  const submit = async () => {
    if (!form.key.trim() || !form.displayName.trim()) return;
    const res = await createMut.mutateAsync({
      key: form.key.trim(),
      displayName: form.displayName.trim(),
      category: form.category.trim() || undefined,
      description: form.description.trim() || undefined,
      tier: form.tier,
      availableToAllTenants: form.availableToAllTenants,
    });
    setCreateOpen(false);
    setForm({ key: '', displayName: '', category: '', description: '', tier: 'essential', availableToAllTenants: false });
    navigate(`/admin/bot-templates/${res.template.id}`);
  };

  if (isLoading) return <PageSkeleton variant="list" rows={5} />;
  if (isError) return <InlineError message={t('admin.botTemplates.errors.load')} />;

  const renderRow = (tpl: BotTemplateSummary) => (
    <TableRow key={tpl.id} className="cursor-pointer" onClick={() => navigate(`/admin/bot-templates/${tpl.id}`)}>
      <TableCell>
        <div className="flex items-start gap-2">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
          <div className="min-w-0">
            <div className="font-medium text-text-primary">{tpl.displayName}</div>
            {tpl.description && <div className="max-w-md truncate text-xs text-text-secondary">{tpl.description}</div>}
            <div className="font-mono text-[10px] text-text-muted">{tpl.key}{tpl.category ? ` · ${tpl.category}` : ''}</div>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={tpl.status === 'active' ? 'default' : 'secondary'}>
          {t(`admin.botTemplates.templateStatus.${tpl.status}`)}
        </Badge>
      </TableCell>
      <TableCell>
        <span className="text-sm text-text-secondary">
          {tpl.availableToAllTenants ? t('admin.botTemplates.availability.all') : t('admin.botTemplates.availability.granted')}
        </span>
      </TableCell>
      <TableCell>
        <span className="text-sm text-text-secondary">
          {tpl.latestPublishedVersion
            ? t('admin.botTemplates.versionSummary.published', { version: tpl.latestPublishedVersion })
            : t('admin.botTemplates.versionSummary.none')}
          {tpl.draftCount > 0 && ` · ${t('admin.botTemplates.versionSummary.drafts', { count: tpl.draftCount })}`}
        </span>
      </TableCell>
      <TableCell><ChevronRight className="h-4 w-4 text-text-muted" /></TableCell>
    </TableRow>
  );

  const renderTier = (tier: (typeof TIERS)[number]) => {
    const rows = (templates ?? []).filter((tpl) => (tpl.tier ?? 'essential') === tier.id);
    return (
      <section key={tier.id} className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className={`mt-1 h-9 w-1 shrink-0 rounded-full ${tier.rail}`} aria-hidden />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-text-primary">{tier.label}</h2>
                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums ${tier.chip}`}>{rows.length}</span>
              </div>
              <p className="text-xs text-text-muted">{tier.blurb}</p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => openCreate(tier.id)}>
            <Plus className="h-3.5 w-3.5" />{t('admin.botTemplates.actions.newInTier', { defaultValue: 'New' })}
          </Button>
        </div>

        <Card variant="glass">
          <CardContent className="p-0">
            {rows.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('admin.botTemplates.columns.name')}</TableHead>
                    <TableHead>{t('admin.botTemplates.columns.status')}</TableHead>
                    <TableHead>{t('admin.botTemplates.columns.availability')}</TableHead>
                    <TableHead>{t('admin.botTemplates.columns.versions')}</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>{rows.map(renderRow)}</TableBody>
              </Table>
            ) : (
              <div className="p-5 text-center text-sm text-text-muted">
                No {tier.label} templates yet —{' '}
                <button type="button" onClick={() => openCreate(tier.id)} className="text-primary-300 hover:underline">create one</button>.
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    );
  };

  return (
    <div className={embedded ? 'space-y-8' : 'h-full overflow-y-auto p-6 space-y-8'}>
      <div className="flex items-center justify-between">
        {embedded ? (
          <p className="text-sm text-text-secondary">{t('admin.botTemplates.header.subtitle')}</p>
        ) : (
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">{t('admin.botTemplates.header.title')}</h1>
            <p className="text-sm text-text-secondary">{t('admin.botTemplates.header.subtitle')}</p>
          </div>
        )}
        <Button onClick={() => openCreate('essential')}>
          <Plus className="h-4 w-4 mr-2" />
          {t('admin.botTemplates.actions.create')}
        </Button>
      </div>

      {TIERS.map(renderTier)}

      {/* Template health (L9) — bots stranded on an unavailable template. Independent
          + fail-soft: its own loading/error/all-clear states never block the tiers above. */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-text-primary">{t('admin.botTemplates.health.title')}</h2>
          {strandedBots.length > 0 && (
            <Badge variant="destructive">{t('admin.botTemplates.health.stranded', { count: health.data?.count ?? strandedBots.length })}</Badge>
          )}
        </div>
        <p className="text-xs text-text-secondary">{t('admin.botTemplates.health.subtitle')}</p>
        <Card variant="glass">
          <CardContent className="p-0">
            {health.isLoading ? (
              <div className="p-4 text-sm text-text-muted">…</div>
            ) : health.isError ? (
              <div className="p-4 text-sm text-status-away">{t('admin.botTemplates.health.loadError')}</div>
            ) : strandedBots.length === 0 ? (
              <div className="flex items-center gap-2 p-4 text-sm text-text-secondary">
                <CircleCheck className="h-4 w-4 text-status-online" />
                {t('admin.botTemplates.health.allClear')}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('admin.botTemplates.health.columns.bot')}</TableHead>
                    <TableHead>{t('admin.botTemplates.health.columns.tenant')}</TableHead>
                    <TableHead>{t('admin.botTemplates.health.columns.template')}</TableHead>
                    <TableHead>{t('admin.botTemplates.health.columns.reason')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {strandedBots.map((b) => (
                    <TableRow key={b.botId}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <TriangleAlert className="h-4 w-4 text-status-away" />
                          <span className="font-medium text-text-primary">{b.botName}</span>
                        </div>
                      </TableCell>
                      <TableCell><span className="text-sm text-text-secondary">{b.tenantName}</span></TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-text-muted">
                          {b.templateId}{b.pinnedVersion && b.pinnedVersion !== 'latest' ? ` @${b.pinnedVersion}` : ''}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={b.reason === 'missing_or_archived' ? 'destructive' : 'warning'}>
                          {t(`admin.botTemplates.health.reason.${b.reason}`)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin.botTemplates.create.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-key">{t('admin.botTemplates.create.key')}</Label>
              <Input id="tpl-key" value={form.key} placeholder="plumber-booking" onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">{t('admin.botTemplates.create.displayName')}</Label>
              <Input id="tpl-name" value={form.displayName} placeholder="Plumber Booking Bot" onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-vertical">{t('admin.botTemplates.create.category')}</Label>
              <Input id="tpl-vertical" value={form.category} placeholder="plumber" onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} />
              <p className="text-xs text-text-muted">{t('admin.botTemplates.create.categoryHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label>Tier</Label>
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Tier">
                {TIERS.map((tr) => (
                  <button
                    key={tr.id}
                    type="button"
                    aria-pressed={form.tier === tr.id}
                    onClick={() => setForm((f) => ({ ...f, tier: tr.id }))}
                    className={`rounded-lg border px-3 py-2 text-sm transition-colors ${form.tier === tr.id ? 'border-primary-400 bg-primary-500/10 text-text-primary' : 'border-edge text-text-secondary hover:border-edge-light'}`}
                  >
                    {tr.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="tpl-global">{t('admin.botTemplates.create.availableToAll')}</Label>
              <Switch id="tpl-global" checked={form.availableToAllTenants} onCheckedChange={(v) => setForm((f) => ({ ...f, availableToAllTenants: v }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={submit} disabled={!form.key.trim() || !form.displayName.trim() || createMut.isPending}>
              {t('admin.botTemplates.actions.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminBotTemplates;
