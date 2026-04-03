import React, { useState } from 'react';
import { Plus, Pencil, Trash2, Zap, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { useAppAuth } from '@/auth/useAppAuth';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { useGetSkills, useCreateSkill, useUpdateSkill, useDeleteSkill } from '@/queries/useSkillsQueries';
import { useAvailableTools } from '@/queries/useOnboardingQueries';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface SkillFormState {
  name: string;
  trigger: string;
  tools: string[];
  instructions: string;
  maxSteps: number;
  enabled: boolean;
}

const defaultForm = (): SkillFormState => ({
  name: '',
  trigger: '',
  tools: [],
  instructions: '',
  maxSteps: 5,
  enabled: true,
});

const SkillsSettings: React.FC = () => {
  const { isRole } = useAppAuth();
  const isAdmin = isRole('admin');

  const { data: skillsData, isLoading, error } = useGetSkills();
  const { data: toolsData } = useAvailableTools();
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<SkillFormState>(defaultForm());
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const skills: Any[] = (skillsData as Any)?.skills ?? [];
  const availableTools: Any[] = (toolsData as Any)?.tools ?? [];

  const openCreate = () => {
    setEditingName(null);
    setForm(defaultForm());
    setDialogOpen(true);
  };

  const openEdit = (skill: Any) => {
    setEditingName(skill.name);
    setForm({
      name: skill.name ?? '',
      trigger: skill.trigger ?? '',
      tools: skill.tools ?? [],
      instructions: skill.instructions ?? '',
      maxSteps: skill.maxSteps ?? 5,
      enabled: skill.enabled ?? true,
    });
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!form.name.trim()) return;
    if (editingName) {
      updateSkill.mutate(
        { name: editingName, data: form },
        { onSuccess: () => setDialogOpen(false) }
      );
    } else {
      createSkill.mutate(form, { onSuccess: () => setDialogOpen(false) });
    }
  };

  const handleToggleEnabled = (skill: Any) => {
    if (!isAdmin) return;
    updateSkill.mutate({ name: skill.name, data: { enabled: !skill.enabled } });
  };

  const handleDelete = (name: string) => {
    deleteSkill.mutate(name, { onSuccess: () => setDeleteConfirm(null) });
  };

  const toggleTool = (toolName: string) => {
    setForm((prev) => ({
      ...prev,
      tools: prev.tools.includes(toolName)
        ? prev.tools.filter((t) => t !== toolName)
        : [...prev.tools, toolName],
    }));
  };

  const isSaving = createSkill.isPending || updateSkill.isPending;

  if (isLoading) return <PageSkeleton variant="list" rows={3} />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary-400" />
            Skills
          </h2>
          <p className="text-sm text-text-secondary mt-0.5">
            Teach your bot new abilities by configuring reusable skills.
          </p>
        </div>
        {isAdmin && (
          <Button onClick={openCreate} size="sm" className="gap-1.5">
            <Plus className="w-4 h-4" />
            Add Skill
          </Button>
        )}
      </div>

      {error && (
        <InlineError message="Failed to load skills. Please refresh the page." />
      )}

      {/* Skills list */}
      {skills.length === 0 && !error ? (
        <Card variant="glass">
          <CardContent className="py-12 text-center">
            <Zap className="w-10 h-10 text-text-muted mx-auto mb-3" />
            <p className="text-text-secondary text-sm">
              No skills configured. Add one to teach your bot new abilities.
            </p>
            {isAdmin && (
              <Button onClick={openCreate} size="sm" className="mt-4 gap-1.5">
                <Plus className="w-4 h-4" />
                Add Skill
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {skills.map((skill: Any) => (
            <Card key={skill.name} variant="glass">
              <CardContent className="py-4">
                <div className="flex items-start gap-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-600/10 mt-0.5">
                    <Zap className="h-4 w-4 text-primary-400" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-text-primary">{skill.name}</p>
                      {skill.enabled ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <Badge variant="secondary">Disabled</Badge>
                      )}
                    </div>
                    {skill.trigger && (
                      <p className="text-xs text-text-muted mt-1 line-clamp-1">
                        Trigger: {skill.trigger}
                      </p>
                    )}
                    {skill.tools?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {skill.tools.map((t: string) => (
                          <Badge key={t} variant="outline" className="text-xs">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <Switch
                      checked={!!skill.enabled}
                      onCheckedChange={() => handleToggleEnabled(skill)}
                      disabled={!isAdmin || updateSkill.isPending}
                    />
                    {isAdmin && (
                      <>
                        <button
                          onClick={() => openEdit(skill)}
                          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
                          title="Edit"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(skill.name)}
                          className="p-1.5 rounded-lg text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingName ? 'Edit Skill' : 'Add Skill'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="skill-name">Name</Label>
              <Input
                id="skill-name"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g. book-appointment"
                disabled={!!editingName}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="skill-trigger">Trigger description</Label>
              <Textarea
                id="skill-trigger"
                value={form.trigger}
                onChange={(e) => setForm((p) => ({ ...p, trigger: e.target.value }))}
                placeholder="Describe when this skill should activate..."
                rows={3}
              />
            </div>

            {availableTools.length > 0 && (
              <div className="space-y-1.5">
                <Label>Tools</Label>
                <div className="grid grid-cols-2 gap-2 p-3 rounded-lg border border-edge bg-surface-2">
                  {availableTools.map((tool: Any) => {
                    const toolName = tool.name ?? tool;
                    return (
                      <label
                        key={toolName}
                        className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={form.tools.includes(toolName)}
                          onChange={() => toggleTool(toolName)}
                          className="rounded border-edge accent-primary"
                        />
                        {toolName}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="skill-instructions">Instructions</Label>
              <Textarea
                id="skill-instructions"
                value={form.instructions}
                onChange={(e) => setForm((p) => ({ ...p, instructions: e.target.value }))}
                placeholder="Step-by-step instructions for the bot..."
                rows={4}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="skill-maxsteps">Max Steps</Label>
              <Input
                id="skill-maxsteps"
                type="number"
                min={1}
                max={20}
                value={form.maxSteps}
                onChange={(e) =>
                  setForm((p) => ({ ...p, maxSteps: Number(e.target.value) }))
                }
              />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg border border-edge bg-surface-2">
              <div>
                <p className="text-sm font-medium text-text-primary">Enabled</p>
                <p className="text-xs text-text-muted">Activate this skill for your bot</p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isSaving || !form.name.trim()}>
              {isSaving ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving...
                </span>
              ) : editingName ? (
                'Save Changes'
              ) : (
                'Create Skill'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0/80 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-edge bg-surface-1 p-6 shadow-lg space-y-4">
            <p className="font-semibold text-text-primary">Delete &ldquo;{deleteConfirm}&rdquo;?</p>
            <p className="text-sm text-text-secondary">
              This will permanently remove the skill. This action cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteConfirm(null)}
                disabled={deleteSkill.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => handleDelete(deleteConfirm)}
                disabled={deleteSkill.isPending}
              >
                {deleteSkill.isPending ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Deleting...
                  </span>
                ) : (
                  'Delete'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SkillsSettings;
