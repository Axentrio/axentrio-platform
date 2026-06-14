/**
 * Super-admin Bot Templates — list + create (.scratch/plan-bot-templates.md,
 * Phase 3b). Versioned prompt identities authored centrally and granted to
 * tenants. Editor lives in AdminBotTemplateDetail.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, FileText } from 'lucide-react';
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
import { useAdminBotTemplates, useCreateBotTemplate } from '../../queries/useBotTemplatesQueries';

const AdminBotTemplates: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: templates, isLoading, isError } = useAdminBotTemplates();
  const createMut = useCreateBotTemplate();

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ key: '', displayName: '', category: '', description: '', availableToAllTenants: false });

  const submit = async () => {
    if (!form.key.trim() || !form.displayName.trim()) return;
    const res = await createMut.mutateAsync({
      key: form.key.trim(),
      displayName: form.displayName.trim(),
      category: form.category.trim() || undefined,
      description: form.description.trim() || undefined,
      availableToAllTenants: form.availableToAllTenants,
    });
    setCreateOpen(false);
    setForm({ key: '', displayName: '', category: '', description: '', availableToAllTenants: false });
    navigate(`/admin/bot-templates/${res.template.id}`);
  };

  if (isLoading) return <PageSkeleton variant="list" rows={5} />;
  if (isError) return <InlineError message={t('admin.botTemplates.errors.load')} />;

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">{t('admin.botTemplates.header.title')}</h1>
          <p className="text-sm text-text-secondary">{t('admin.botTemplates.header.subtitle')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          {t('admin.botTemplates.actions.create')}
        </Button>
      </div>

      <Card variant="glass">
        <CardContent className="p-0">
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
            <TableBody>
              {(templates ?? []).map((tpl) => (
                <TableRow
                  key={tpl.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/admin/bot-templates/${tpl.id}`)}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-text-tertiary" />
                      <div>
                        <div className="font-medium text-text-primary">{tpl.displayName}</div>
                        <div className="text-xs text-text-tertiary font-mono">{tpl.key}</div>
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
                      {tpl.availableToAllTenants
                        ? t('admin.botTemplates.availability.all')
                        : t('admin.botTemplates.availability.granted')}
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
                  <TableCell>
                    <ChevronRight className="h-4 w-4 text-text-tertiary" />
                  </TableCell>
                </TableRow>
              ))}
              {(templates ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-text-tertiary py-8">
                    {t('admin.botTemplates.empty')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin.botTemplates.create.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-key">{t('admin.botTemplates.create.key')}</Label>
              <Input
                id="tpl-key"
                value={form.key}
                placeholder="plumber-booking"
                onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">{t('admin.botTemplates.create.displayName')}</Label>
              <Input
                id="tpl-name"
                value={form.displayName}
                placeholder="Plumber Booking Bot"
                onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-category">{t('admin.botTemplates.create.category')}</Label>
              <Input
                id="tpl-category"
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="tpl-global">{t('admin.botTemplates.create.availableToAll')}</Label>
              <Switch
                id="tpl-global"
                checked={form.availableToAllTenants}
                onCheckedChange={(v) => setForm((f) => ({ ...f, availableToAllTenants: v }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
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
