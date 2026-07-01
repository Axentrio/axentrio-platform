/**
 * Super-admin Modules — authoring UI for composable templates (Phase 5).
 *
 * A Module is reusable, authored prose that binds ONE engineered skill (v1). This
 * page is the producer; the template editor's module-select is the consumer.
 * Skills themselves are engineered (code) and not authorable — they appear here
 * read-only, as the options a module may bind.
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Boxes, Cpu, ChevronRight } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SkillMultiSelect } from '@/components/admin/SkillMultiSelect';
import {
  useAdminModules,
  useAdminSkills,
  useCreateModule,
} from '../../queries/useBotTemplatesQueries';
import { COMPOSABLE_TEMPLATES_ENABLED } from '@/config/featureFlags';
import { SkillsReference } from '@/components/admin/SkillsReference';

const latestVersion = (versions: { version: number; status: string }[]) =>
  versions.length ? [...versions].sort((a, b) => b.version - a.version)[0] : undefined;

const AdminModules: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const navigate = useNavigate();
  const { data: modules, isLoading, isError } = useAdminModules();
  const { data: skills } = useAdminSkills();
  const createMut = useCreateModule();

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<{ name: string; description: string; skillIds: string[]; prose: string }>({
    name: '',
    description: '',
    skillIds: [],
    prose: '',
  });

  const skillName = (id: string) => skills?.find((s) => s.id === id)?.displayName ?? id;
  const canSubmit = form.name.trim() && form.skillIds.length > 0 && !createMut.isPending;

  const submit = async () => {
    if (!canSubmit) return;
    await createMut.mutateAsync({
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      skillIds: form.skillIds,
      prose: form.prose.trim() || undefined,
    });
    setCreateOpen(false);
    setForm({ name: '', description: '', skillIds: [], prose: '' });
  };

  if (!COMPOSABLE_TEMPLATES_ENABLED) {
    return (
      <div className="p-6">
        <InlineError message="Modules are part of composable templates, which is disabled in this environment (COMPOSABLE_TEMPLATES_ENABLED)." />
      </div>
    );
  }
  if (isLoading) return <PageSkeleton variant="list" rows={5} />;
  if (isError) return <InlineError message="Couldn't load modules." />;

  return (
    <div className={embedded ? 'space-y-6' : 'h-full overflow-y-auto p-6 space-y-6'}>
      <div className="flex items-center justify-between">
        {embedded ? (
          <p className="text-sm text-text-secondary">
            Reusable prose that binds one engineered skill. Selected in bot templates.
          </p>
        ) : (
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Modules</h1>
            <p className="text-sm text-text-secondary">
              Authored, reusable prose that binds one engineered skill. Selected in bot templates.
            </p>
          </div>
        )}
        <Button onClick={() => setCreateOpen(true)} disabled={!skills?.length}>
          <Plus className="h-4 w-4 mr-2" />
          New module
        </Button>
      </div>

      <Card variant="glass">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Binds skill</TableHead>
                <TableHead>Latest version</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(modules ?? []).map(({ module, versions }) => {
                const latest = latestVersion(versions);
                return (
                  <TableRow
                    key={module.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/admin/modules/${module.id}`)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Boxes className="h-4 w-4 text-text-muted" />
                        <div>
                          <div className="font-medium text-text-primary">{module.name}</div>
                          {module.description && (
                            <div className="text-xs text-text-muted">{module.description}</div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {(module.skillIds.length ? module.skillIds : ['—']).map((sid) => (
                          <span key={sid} className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-2 px-2 py-0.5 text-xs text-text-secondary">
                            <Cpu className="h-3 w-3 text-text-muted" />
                            {skillName(sid)}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      {latest ? (
                        <span className="text-sm text-text-secondary">
                          v{latest.version}{' '}
                          <Badge variant={latest.status === 'published' ? 'default' : 'secondary'}>{latest.status}</Badge>
                        </span>
                      ) : (
                        <span className="text-sm text-text-muted">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <ChevronRight className="h-4 w-4 text-text-muted" />
                    </TableCell>
                  </TableRow>
                );
              })}
              {(modules ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-text-muted py-8">
                    No modules yet — create one to use it in a bot template.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Standalone page shows the skills reference inline; in Studio it's its own tab. */}
      {!embedded && <SkillsReference />}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New module</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="mod-name">Name</Label>
              <Input
                id="mod-name"
                value={form.name}
                placeholder="Salon Booking Concierge"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mod-desc">Description</Label>
              <Input
                id="mod-desc"
                value={form.description}
                placeholder="What this module is for"
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Binds skills</Label>
              <SkillMultiSelect
                skills={skills ?? []}
                value={form.skillIds}
                onChange={(ids) => setForm((f) => ({ ...f, skillIds: ids }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mod-prose">Prose</Label>
              <Textarea
                id="mod-prose"
                rows={5}
                value={form.prose}
                placeholder="Workflow intent + wording. Describe HOW the bot should handle this — no tool names or capability claims."
                onChange={(e) => setForm((f) => ({ ...f, prose: e.target.value }))}
              />
              <p className="text-xs text-text-muted">
                Intent only — naming a tool (e.g. "call create_booking") is rejected on publish.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!canSubmit}>Create draft</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminModules;
