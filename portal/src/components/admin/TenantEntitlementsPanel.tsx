/**
 * Super-admin entitlement controls for one tenant — feature overrides
 * (tri-state per feature: tier default / forced on / forced off) and bespoke
 * module enablement. Mounted on AdminTenantDetail.
 *
 * Admin-internal surface — intentionally not i18n'd (English-only, matches
 * the operator-facing backend reasons/audit strings).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, ShieldCheck, Boxes, ChevronDown } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useTenantOverrides,
  useSetTenantOverrides,
  useTenantModules,
  useSetTenantModule,
  type TenantModuleRow,
} from '../../queries/useAdminQueries';

type TriState = 'default' | 'on' | 'off';

interface OverrideDraft {
  state: TriState;
  reason: string;
}

/** Fallbacks while the (taxonomy-bearing) response loads or for older API. */
const FALLBACK_GROUP = { label: 'Other' };

export function TenantEntitlementsPanel({ tenantId }: { tenantId: string }) {
  const { data: overridesData, isLoading: overridesLoading } = useTenantOverrides(tenantId);
  const setOverrides = useSetTenantOverrides(tenantId);
  const { data: modules, isLoading: modulesLoading } = useTenantModules(tenantId);
  const setModule = useSetTenantModule(tenantId);

  const [drafts, setDrafts] = useState<Record<string, OverrideDraft>>({});

  // Seed drafts from the server state whenever it (re)loads.
  useEffect(() => {
    if (!overridesData) return;
    const next: Record<string, OverrideDraft> = {};
    for (const key of Object.keys(overridesData.tierDefaults)) {
      const ov = overridesData.overrides[key];
      next[key] = ov ? { state: ov.value ? 'on' : 'off', reason: ov.reason } : { state: 'default', reason: '' };
    }
    setDrafts(next);
  }, [overridesData]);

  const dirty = useMemo(() => {
    if (!overridesData) return false;
    return Object.keys(overridesData.tierDefaults).some((key) => {
      const ov = overridesData.overrides[key];
      const d = drafts[key];
      if (!d) return false;
      const serverState: TriState = ov ? (ov.value ? 'on' : 'off') : 'default';
      const serverReason = ov?.reason ?? '';
      return d.state !== serverState || (d.state !== 'default' && d.reason !== serverReason);
    });
  }, [overridesData, drafts]);

  const missingReason = useMemo(
    () => Object.values(drafts).some((d) => d.state !== 'default' && !d.reason.trim()),
    [drafts],
  );

  const handleSave = () => {
    const payload: Record<string, { value: boolean; reason: string }> = {};
    for (const [key, d] of Object.entries(drafts)) {
      if (d.state === 'default') continue; // absent = tier default (deletion)
      payload[key] = { value: d.state === 'on', reason: d.reason.trim() };
    }
    setOverrides.mutate(payload);
  };

  return (
    <div className="space-y-6">
      {/* Feature overrides */}
      <Card variant="glass" className="overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge">
          <h3 className="font-semibold text-text-primary flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary-400" /> Feature overrides
          </h3>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!dirty || missingReason || setOverrides.isPending}
          >
            {setOverrides.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save overrides'}
          </Button>
        </div>
        {overridesLoading || !overridesData ? (
          <div className="p-6 text-sm text-text-muted">Loading…</div>
        ) : (
          <GroupedOverrideRows
            data={overridesData}
            drafts={drafts}
            setDrafts={setDrafts}
          />
        )}
      </Card>

      {/* Bespoke modules */}
      <Card variant="glass" className="overflow-hidden">
        <div className="px-6 py-4 border-b border-edge">
          <h3 className="font-semibold text-text-primary flex items-center gap-2">
            <Boxes className="w-4 h-4 text-accent-400" /> Bespoke modules
          </h3>
        </div>
        {modulesLoading ? (
          <div className="p-6 text-sm text-text-muted">Loading…</div>
        ) : !modules?.length ? (
          <div className="p-6 text-sm text-text-muted">
            No bespoke modules in the catalog yet. Feature-gated modules (e.g. Bookings) follow the
            tenant's plan and the overrides above.
          </div>
        ) : (
          <div className="divide-y divide-edge">
            {modules.map((m) => (
              <ModuleRow key={m.id} module={m} onSave={(input) => setModule.mutate(input)} saving={setModule.isPending} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * Grouped renderer for the override rows: features cluster by taxonomy group;
 * a child feature (`requires`) renders indented and is locked to "off" while
 * its parent is effectively off (the backend enforces the same rule in the
 * resolver — this is the matching affordance). "Plan traits" starts collapsed.
 */
function GroupedOverrideRows({
  data,
  drafts,
  setDrafts,
}: {
  data: import('../../queries/useAdminQueries').TenantOverridesResponse;
  drafts: Record<string, OverrideDraft>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, OverrideDraft>>>;
}) {
  const taxonomy = data.taxonomy ?? {};
  const groups = data.groups ?? {};
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(Object.entries(groups).map(([id, g]) => [id, !g.collapsed])),
  );

  // Effective value of a feature under the current drafts (tier default unless forced).
  const effective = (key: string): boolean => {
    const d = drafts[key];
    if (!d || d.state === 'default') return data.tierDefaults[key] ?? false;
    return d.state === 'on';
  };

  // Group ids in taxonomy declaration order; unknown features fall into 'other'.
  const groupIds = [...new Set(Object.values(taxonomy).map((m) => m.group))];
  const ungrouped = Object.keys(data.tierDefaults).filter((k) => !taxonomy[k]);
  const ordered: Array<{ id: string; label: string; keys: string[] }> = groupIds.map((gid) => ({
    id: gid,
    label: groups[gid]?.label ?? gid,
    // Parents before their children within a group.
    keys: Object.keys(data.tierDefaults)
      .filter((k) => taxonomy[k]?.group === gid)
      .sort((a, b) => Number(!!taxonomy[a]?.requires) - Number(!!taxonomy[b]?.requires)),
  }));
  if (ungrouped.length) ordered.push({ id: 'other', label: FALLBACK_GROUP.label, keys: ungrouped });

  return (
    <div>
      {ordered.map((g) => {
        const open = openGroups[g.id] ?? true;
        return (
          <div key={g.id} className="border-b border-edge last:border-b-0">
            <button
              type="button"
              className="w-full px-6 py-2.5 flex items-center gap-2 text-left bg-surface-2/40 hover:bg-surface-2/70"
              onClick={() => setOpenGroups((p) => ({ ...p, [g.id]: !open }))}
            >
              <ChevronDown className={`w-3.5 h-3.5 text-text-muted transition-transform ${open ? '' : '-rotate-90'}`} />
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{g.label}</span>
            </button>
            {open && (
              <div className="divide-y divide-edge/50">
                {g.keys.map((key) => {
                  const meta = taxonomy[key];
                  const isChild = !!meta?.requires;
                  const parentOn = !isChild || effective(meta!.requires!);
                  const draft = drafts[key] ?? { state: 'default' as TriState, reason: '' };
                  const existing = data.overrides[key];
                  return (
                    <div key={key} className={`px-6 py-3 flex flex-wrap items-center gap-3 ${isChild ? 'pl-12' : ''}`}>
                      <div className="min-w-[220px] flex-1">
                        <p className="text-sm text-text-primary">{meta?.label ?? key}</p>
                        <p className="text-xs text-text-muted">
                          {!parentOn ? (
                            <>off — requires {taxonomy[meta!.requires!]?.label ?? meta!.requires}</>
                          ) : (
                            <>
                              Tier default ({data.tier}): {data.tierDefaults[key] ? 'on' : 'off'}
                              {existing && draft.state !== 'default' && (
                                <> · overridden by {existing.setBy} on {existing.setAt.slice(0, 10)}</>
                              )}
                            </>
                          )}
                        </p>
                      </div>
                      <Select
                        value={parentOn ? draft.state : 'default'}
                        disabled={!parentOn}
                        onValueChange={(state: TriState) =>
                          setDrafts((prev) => ({ ...prev, [key]: { ...draft, state } }))
                        }
                      >
                        <SelectTrigger className="w-[150px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Tier default</SelectItem>
                          <SelectItem value="on">Force on</SelectItem>
                          <SelectItem value="off">Force off</SelectItem>
                        </SelectContent>
                      </Select>
                      {parentOn && draft.state !== 'default' && (
                        <Input
                          className="w-[260px]"
                          placeholder="Reason (required)"
                          value={draft.reason}
                          onChange={(e) =>
                            setDrafts((prev) => ({ ...prev, [key]: { ...draft, reason: e.target.value } }))
                          }
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ModuleRow({
  module: m,
  onSave,
  saving,
}: {
  module: TenantModuleRow;
  onSave: (input: { moduleId: string; enabled: boolean; reason: string; config?: Record<string, unknown> }) => void;
  saving: boolean;
}) {
  const [reason, setReason] = useState('');
  const [configText, setConfigText] = useState(() => JSON.stringify(m.config ?? {}, null, 2));
  const [configError, setConfigError] = useState<string | null>(null);

  const handleToggle = (enabled: boolean) => {
    if (!reason.trim()) {
      setConfigError('A reason is required to enable or disable a module.');
      return;
    }
    let config: Record<string, unknown> | undefined;
    if (m.hasConfigSchema || configText.trim() !== JSON.stringify(m.config ?? {}, null, 2).trim()) {
      try {
        config = JSON.parse(configText || '{}');
        setConfigError(null);
      } catch {
        setConfigError('Config is not valid JSON.');
        return;
      }
    }
    setConfigError(null);
    onSave({ moduleId: m.id, enabled, reason: reason.trim(), config });
  };

  return (
    <div className="px-6 py-4 space-y-2">
      <div className="flex items-center gap-3">
        <p className="text-sm text-text-primary flex-1">{m.displayName}</p>
        <Badge variant={m.active ? 'default' : 'secondary'}>{m.active ? 'Active' : 'Inactive'}</Badge>
        <Button size="sm" variant={m.enabled ? 'destructive' : 'default'} disabled={saving} onClick={() => handleToggle(!m.enabled)}>
          {m.enabled ? 'Disable' : 'Enable'}
        </Button>
      </div>
      {m.setBy && (
        <p className="text-xs text-text-muted">
          {m.enabled ? 'Enabled' : 'Disabled'} by {m.setBy}
          {m.reason ? ` — "${m.reason}"` : ''}
        </p>
      )}
      <Input placeholder="Reason (required for changes)" value={reason} onChange={(e) => setReason(e.target.value)} />
      {m.hasConfigSchema && (
        <textarea
          className="w-full h-28 rounded-md border border-edge bg-surface-2 p-2 font-mono text-xs text-text-primary"
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          spellCheck={false}
          aria-label={`${m.displayName} config (JSON)`}
        />
      )}
      {configError && <p className="text-xs text-status-error">{configError}</p>}
    </div>
  );
}
