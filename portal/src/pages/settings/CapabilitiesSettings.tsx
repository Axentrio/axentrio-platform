import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, Zap, Loader2, ToggleLeft, Bell } from 'lucide-react';
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
import { useGetAutomations, useUpdateAutomation } from '@/queries/useAutomationsQueries';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// Internal tool identifiers — mapped to i18n keys for friendly display names
const TOOL_LABEL_KEYS: Record<string, string> = {
  kb_search: 'settings.capabilities.tools.kb_search',
  escalate_to_human: 'settings.capabilities.tools.escalate_to_human',
  capture_lead: 'settings.capabilities.tools.capture_lead',
  check_availability: 'settings.capabilities.tools.check_availability',
  create_booking: 'settings.capabilities.tools.create_booking',
  list_bookings: 'settings.capabilities.tools.list_bookings',
  reschedule_booking: 'settings.capabilities.tools.reschedule_booking',
  cancel_booking: 'settings.capabilities.tools.cancel_booking',
};

interface SkillFormState {
  name: string;
  displayName: string;
  description: string;
  trigger: string;
  tools: string[];
  instructions: string;
  maxSteps: number;
  enabled: boolean;
}

const defaultForm = (): SkillFormState => ({
  name: '',
  displayName: '',
  description: '',
  trigger: '',
  tools: [],
  instructions: '',
  maxSteps: 5,
  enabled: true,
});

// ─── Tenant Admin View ───────────────────────────────────────────────
// Read-only capability cards with on/off toggle only

const TenantCapabilitiesView: React.FC<{
  skills: Any[];
  isAdmin: boolean;
  onToggle: (skill: Any) => void;
  isToggling: boolean;
}> = ({ skills, isAdmin, onToggle, isToggling }) => {
  const { t } = useTranslation();

  if (skills.length === 0) {
    return (
      <Card variant="glass">
        <CardContent className="py-12 text-center">
          <ToggleLeft className="w-10 h-10 text-text-muted mx-auto mb-3" />
          <p className="text-text-secondary text-sm">
            {t('settings.capabilities.tenantView.emptyState')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {skills.map((skill: Any) => {
        const label = skill.displayName || formatName(skill.name);
        const desc = skill.description || skill.trigger || t('settings.capabilities.tenantView.noDescription');

        return (
          <Card key={skill.name} variant="glass">
            <CardContent className="py-4">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-600/10 mt-0.5">
                  <Zap className="h-4 w-4 text-primary-400" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-text-primary">{label}</p>
                    <Switch
                      checked={!!skill.enabled}
                      onCheckedChange={() => onToggle(skill)}
                      disabled={!isAdmin || isToggling}
                    />
                  </div>
                  <p className="text-xs text-text-muted mt-1 line-clamp-2">
                    {desc}
                  </p>
                  {skill.tools?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {skill.tools.map((toolName: string) => (
                        <Badge key={toolName} variant="outline" className="text-xs">
                          {TOOL_LABEL_KEYS[toolName] ? t(TOOL_LABEL_KEYS[toolName]) : toolName}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
};

// ─── Super Admin View ────────────────────────────────────────────────
// Full CRUD with all technical fields

const SuperAdminSkillsView: React.FC<{
  skills: Any[];
  onToggle: (skill: Any) => void;
  onEdit: (skill: Any) => void;
  onCreate: () => void;
  isToggling: boolean;
}> = ({ skills, onToggle, onEdit, onCreate, isToggling }) => {
  const { t } = useTranslation();
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const deleteSkill = useDeleteSkill();

  const handleDelete = (name: string) => {
    deleteSkill.mutate(name, { onSuccess: () => setDeleteConfirm(null) });
  };

  return (
    <>
      {skills.length === 0 ? (
        <Card variant="glass">
          <CardContent className="py-12 text-center">
            <Zap className="w-10 h-10 text-text-muted mx-auto mb-3" />
            <p className="text-text-secondary text-sm">
              {t('settings.capabilities.superAdminView.emptyState')}
            </p>
            <Button onClick={onCreate} size="sm" className="mt-4 gap-1.5">
              <Plus className="w-4 h-4" />
              {t('settings.capabilities.header.addButton')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {skills.map((skill: Any) => {
            const label = skill.displayName || formatName(skill.name);
            return (
              <Card key={skill.name} variant="glass">
                <CardContent className="py-4">
                  <div className="flex items-start gap-4">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-600/10 mt-0.5">
                      <Zap className="h-4 w-4 text-primary-400" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-text-primary">{label}</p>
                        <span className="text-xs text-text-muted font-mono">({skill.name})</span>
                        {skill.enabled ? (
                          <Badge variant="success">{t('settings.capabilities.superAdminView.statusActive')}</Badge>
                        ) : (
                          <Badge variant="secondary">{t('settings.capabilities.superAdminView.statusDisabled')}</Badge>
                        )}
                      </div>
                      {skill.description && (
                        <p className="text-xs text-text-secondary mt-1 line-clamp-1">
                          {skill.description}
                        </p>
                      )}
                      {skill.trigger && (
                        <p className="text-xs text-text-muted mt-0.5 line-clamp-1">
                          {t('settings.capabilities.superAdminView.triggerPrefix')} {skill.trigger}
                        </p>
                      )}
                      {skill.tools?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {skill.tools.map((toolName: string) => (
                            <Badge key={toolName} variant="outline" className="text-xs">
                              {toolName}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <Switch
                        checked={!!skill.enabled}
                        onCheckedChange={() => onToggle(skill)}
                        disabled={isToggling}
                      />
                      <button
                        type="button"
                        onClick={() => onEdit(skill)}
                        className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
                        title={t('common.edit')}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteConfirm(skill.name)}
                        className="p-1.5 rounded-lg text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        title={t('common.delete')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0/80 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-edge bg-surface-1 p-6 shadow-lg space-y-4">
            <p className="font-semibold text-text-primary">{t('settings.capabilities.deleteDialog.title', { name: deleteConfirm })}</p>
            <p className="text-sm text-text-secondary">
              {t('settings.capabilities.deleteDialog.description')}
            </p>
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteConfirm(null)}
                disabled={deleteSkill.isPending}
              >
                {t('common.cancel')}
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
                    {t('settings.capabilities.deleteDialog.deleting')}
                  </span>
                ) : (
                  t('common.delete')
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

// ─── Helpers ─────────────────────────────────────────────────────────

function formatName(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Team Notifications Section ─────────────────────────────────────

const NOTIFICATION_TYPES = [
  {
    type: 'newLeadAlert',
    titleKey: 'settings.capabilities.teamNotifications.types.newLeadAlert.title',
    descriptionKey: 'settings.capabilities.teamNotifications.types.newLeadAlert.description',
  },
  {
    type: 'conversationSummary',
    titleKey: 'settings.capabilities.teamNotifications.types.conversationSummary.title',
    descriptionKey: 'settings.capabilities.teamNotifications.types.conversationSummary.description',
  },
] as const;

const TeamNotificationsSection: React.FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
  const { t } = useTranslation();
  const { data: automationsData, isLoading } = useGetAutomations();
  const updateAutomation = useUpdateAutomation();

  if (isLoading || !automationsData) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Bell className="w-5 h-5 text-primary-400" />
            {t('settings.capabilities.teamNotifications.title')}
          </h2>
          <p className="text-sm text-text-secondary mt-0.5">{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  const automations: Any = (automationsData as Any)?.automations ?? {};
  const emailNotifications: Any = automations?.emailNotifications ?? {};

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <Bell className="w-5 h-5 text-primary-400" />
          {t('settings.capabilities.teamNotifications.title')}
        </h2>
        <p className="text-sm text-text-secondary mt-0.5">
          {t('settings.capabilities.teamNotifications.description')}
        </p>
      </div>

      <div className="space-y-3">
        {NOTIFICATION_TYPES.map((def) => (
          <NotificationCard
            key={def.type}
            definition={def}
            serverData={emailNotifications[def.type] ?? null}
            isAdmin={isAdmin}
            onUpdate={(data) => updateAutomation.mutate({ type: def.type, data })}
            isSaving={updateAutomation.isPending}
          />
        ))}
      </div>
    </div>
  );
};

const NotificationCard: React.FC<{
  definition: { type: string; titleKey: string; descriptionKey: string };
  serverData: Any;
  isAdmin: boolean;
  onUpdate: (data: Any) => void;
  isSaving: boolean;
}> = ({ definition, serverData, isAdmin, onUpdate, isSaving }) => {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [recipients, setRecipients] = useState('');
  const [dirty, setDirty] = useState(false);

  // Sync the editable form from server data whenever it changes — done during
  // render (React's adjusting-state pattern) to avoid the stale-UI flash of an
  // effect.
  const [syncedData, setSyncedData] = useState<Any>(null);
  if (serverData && serverData !== syncedData) {
    setSyncedData(serverData);
    setEnabled(serverData.enabled ?? false);
    setRecipients(Array.isArray(serverData.recipients) ? serverData.recipients.join(', ') : '');
    setDirty(false);
  }

  const handleToggle = (checked: boolean) => {
    if (!isAdmin) return;
    if (!checked) {
      setEnabled(false);
      onUpdate({ enabled: false });
    } else {
      // Show the recipients field — don't send to backend until recipients are provided
      setEnabled(true);
      setDirty(true);
    }
  };

  const handleSave = () => {
    const recipientList = recipients.split(',').flatMap((r: string) => { const v = r.trim(); return v ? [v] : []; });
    if (enabled && recipientList.length === 0) return;
    onUpdate({ enabled, recipients: recipientList });
  };

  return (
    <Card variant="glass">
      <CardContent className="py-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-600/10 mt-0.5">
            <Bell className="h-4 w-4 text-primary-400" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="font-medium text-text-primary">{t(definition.titleKey)}</p>
                <p className="text-xs text-text-muted mt-0.5">{t(definition.descriptionKey)}</p>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={handleToggle}
                disabled={!isAdmin || isSaving}
              />
            </div>

            {enabled && (
              <div className="mt-3 space-y-2">
                <div className="space-y-1">
                  <Label htmlFor={`${definition.type}-recipients`} className="text-xs">
                    {t('settings.capabilities.teamNotifications.recipients.label')}
                    <span className="ml-1 text-text-muted font-normal">{t('settings.capabilities.teamNotifications.recipients.commaSeparated')}</span>
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id={`${definition.type}-recipients`}
                      value={recipients}
                      onChange={(e) => { setRecipients(e.target.value); setDirty(true); }}
                      placeholder={t('settings.capabilities.teamNotifications.recipients.placeholder')}
                      disabled={!isAdmin}
                      className="text-sm"
                    />
                    {dirty && (
                      <Button
                        size="sm"
                        onClick={handleSave}
                        disabled={isSaving}
                      >
                        {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('common.save')}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

// ─── Main Component ──────────────────────────────────────────────────

const CapabilitiesSettings: React.FC = () => {
  const { t } = useTranslation();
  const { user, isRole } = useAppAuth();
  const isAdmin = isRole('admin');
  const isSuperAdmin = user?.role === 'super_admin';

  const { data: skillsData, isLoading, error } = useGetSkills();
  const { data: toolsData } = useAvailableTools();
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<SkillFormState>(defaultForm());

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
      displayName: skill.displayName ?? '',
      description: skill.description ?? '',
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

  const toggleTool = (toolName: string) => {
    setForm((prev) => ({
      ...prev,
      tools: prev.tools.includes(toolName)
        ? prev.tools.filter((tn) => tn !== toolName)
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
            {t('settings.capabilities.header.title')}
          </h2>
          <p className="text-sm text-text-secondary mt-0.5">
            {isSuperAdmin
              ? t('settings.capabilities.header.descriptionSuperAdmin')
              : t('settings.capabilities.header.descriptionAdmin')}
          </p>
        </div>
        {isSuperAdmin && (
          <Button onClick={openCreate} size="sm" className="gap-1.5">
            <Plus className="w-4 h-4" />
            {t('settings.capabilities.header.addButton')}
          </Button>
        )}
      </div>

      {error && (
        <InlineError message={t('settings.capabilities.errors.loadFailed')} />
      )}

      {/* Capabilities list — role-based view */}
      {isSuperAdmin ? (
        <SuperAdminSkillsView
          skills={skills}
          onToggle={handleToggleEnabled}
          onEdit={openEdit}
          onCreate={openCreate}
          isToggling={updateSkill.isPending}
        />
      ) : (
        <TenantCapabilitiesView
          skills={skills}
          isAdmin={isAdmin}
          onToggle={handleToggleEnabled}
          isToggling={updateSkill.isPending}
        />
      )}

      {/* Team Notifications */}
      {isAdmin && <TeamNotificationsSection isAdmin={isAdmin} />}

      {/* Create / Edit Dialog — super_admin only */}
      {isSuperAdmin && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingName ? t('settings.capabilities.dialog.editTitle') : t('settings.capabilities.dialog.addTitle')}</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="skill-name">{t('settings.capabilities.dialog.internalName.label')}</Label>
                <Input
                  id="skill-name"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder={t('settings.capabilities.dialog.internalName.placeholder')}
                  disabled={!!editingName}
                />
                <p className="text-xs text-text-muted">{t('settings.capabilities.dialog.internalName.helper')}</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="skill-displayName">{t('settings.capabilities.dialog.displayName.label')}</Label>
                <Input
                  id="skill-displayName"
                  value={form.displayName}
                  onChange={(e) => setForm((p) => ({ ...p, displayName: e.target.value }))}
                  placeholder={t('settings.capabilities.dialog.displayName.placeholder')}
                />
                <p className="text-xs text-text-muted">{t('settings.capabilities.dialog.displayName.helper')}</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="skill-description">{t('settings.capabilities.dialog.description.label')}</Label>
                <Textarea
                  id="skill-description"
                  value={form.description}
                  onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                  placeholder={t('settings.capabilities.dialog.description.placeholder')}
                  rows={2}
                />
                <p className="text-xs text-text-muted">{t('settings.capabilities.dialog.description.helper')}</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="skill-trigger">{t('settings.capabilities.dialog.trigger.label')}</Label>
                <Textarea
                  id="skill-trigger"
                  value={form.trigger}
                  onChange={(e) => setForm((p) => ({ ...p, trigger: e.target.value }))}
                  placeholder={t('settings.capabilities.dialog.trigger.placeholder')}
                  rows={3}
                />
              </div>

              {availableTools.length > 0 && (
                <div className="space-y-1.5">
                  <Label>{t('settings.capabilities.dialog.tools.label')}</Label>
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
                <Label htmlFor="skill-instructions">{t('settings.capabilities.dialog.instructions.label')}</Label>
                <Textarea
                  id="skill-instructions"
                  value={form.instructions}
                  onChange={(e) => setForm((p) => ({ ...p, instructions: e.target.value }))}
                  placeholder={t('settings.capabilities.dialog.instructions.placeholder')}
                  rows={4}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="skill-maxsteps">{t('settings.capabilities.dialog.maxSteps.label')}</Label>
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
                  <p className="text-sm font-medium text-text-primary">{t('settings.capabilities.dialog.enabled.title')}</p>
                  <p className="text-xs text-text-muted">{t('settings.capabilities.dialog.enabled.description')}</p>
                </div>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleSubmit} disabled={isSaving || !form.name.trim()}>
                {isSaving ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('settings.capabilities.dialog.saving')}
                  </span>
                ) : editingName ? (
                  t('common.save')
                ) : (
                  t('settings.capabilities.dialog.createCapability')
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};

export default CapabilitiesSettings;
