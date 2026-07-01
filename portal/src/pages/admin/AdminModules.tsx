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
import { Plus, Boxes, Cpu } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SkillMultiSelect } from '@/components/admin/SkillMultiSelect';
import {
  useAdminModules,
  useAdminSkills,
  useCreateModule,
} from '../../queries/useBotTemplatesQueries';
import { COMPOSABLE_TEMPLATES_ENABLED } from '@/config/featureFlags';
import { SkillsReference } from '@/components/admin/SkillsReference';

const latestVersion = <T extends { version: number }>(versions: T[]): T | undefined =>
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
            Reusable prose that binds one or more skills. Add modules to your bot templates.
          </p>
        ) : (
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Modules</h1>
            <p className="text-sm text-text-secondary">
              Authored, reusable prose that binds one or more engineered skills. Added to bot templates.
            </p>
          </div>
        )}
        <Button onClick={() => setCreateOpen(true)} disabled={!skills?.length}>
          <Plus className="h-4 w-4 mr-2" />
          New module
        </Button>
      </div>

      {(modules ?? []).length === 0 ? (
        <Card variant="glass">
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-edge bg-surface-2">
              <Boxes className="h-5 w-5 text-text-muted" />
            </span>
            <p className="text-sm text-text-primary">No modules yet</p>
            <p className="max-w-sm text-xs text-text-muted">
              Author reusable prose once — a booking flow, an after-hours message — then add it to any template.
            </p>
            <Button className="mt-2" onClick={() => setCreateOpen(true)} disabled={!skills?.length}>
              <Plus className="mr-2 h-4 w-4" />
              New module
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {(modules ?? []).map(({ module, versions }) => {
            const latest = latestVersion(versions);
            return (
              <Card
                key={module.id}
                variant="glass"
                className="cursor-pointer transition-colors hover:border-edge-light"
                onClick={() => navigate(`/admin/modules/${module.id}`)}
              >
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge bg-surface-2">
                        <Boxes className="h-4 w-4 text-text-secondary" />
                      </span>
                      <div className="truncate font-medium text-text-primary">{module.name}</div>
                    </div>
                    {latest && (
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-muted">
                        v{latest.version}
                        <Badge variant={latest.status === 'published' ? 'default' : 'secondary'}>{latest.status}</Badge>
                      </span>
                    )}
                  </div>

                  {/* A module is its prose — lead with a preview of its voice. */}
                  <p className="line-clamp-3 min-h-[3.75rem] text-sm text-text-secondary">
                    {latest?.prose?.trim() || <span className="text-text-muted">No prose yet — open to write it.</span>}
                  </p>

                  <div className="flex flex-wrap gap-1.5">
                    {(module.skillIds.length ? module.skillIds : ['—']).map((sid) => (
                      <span
                        key={sid}
                        className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-2 px-2 py-0.5 text-xs text-text-secondary"
                      >
                        <Cpu className="h-3 w-3 text-text-muted" />
                        {skillName(sid)}
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {/* Ghost card — fills the grid + an inline way to add another module. */}
          <button
            onClick={() => setCreateOpen(true)}
            disabled={!skills?.length}
            className="flex min-h-[11rem] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-edge text-text-muted transition-colors hover:border-edge-light hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-5 w-5" />
            <span className="text-sm">New module</span>
          </button>
        </div>
      )}

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
