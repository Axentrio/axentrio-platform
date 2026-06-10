/**
 * Super-admin entitlement controls for one tenant — feature overrides
 * (tri-state per feature: tier default / forced on / forced off) and bespoke
 * module enablement. Mounted on AdminTenantDetail.
 *
 * Admin-internal surface — intentionally not i18n'd (English-only, matches
 * the operator-facing backend reasons/audit strings).
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, ShieldCheck, Boxes } from 'lucide-react';
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

const FEATURE_LABELS: Record<string, string> = {
  unifiedInbox: 'Unified inbox',
  bookings: 'Bookings',
  calendarIntegrations: 'Calendar sync (Google/Outlook)',
  leadCapture: 'Lead capture',
  platformAssistant: 'AI Platform Assistant',
  crm: 'CRM',
  hideWidgetAttribution: 'Hide widget attribution',
  customWidgetAppearance: 'Custom widget appearance',
  handoff: 'Human handoff',
  fileUpload: 'File upload',
};

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
          <div className="divide-y divide-edge">
            {Object.entries(overridesData.tierDefaults).map(([key, tierDefault]) => {
              const draft = drafts[key] ?? { state: 'default' as TriState, reason: '' };
              const existing = overridesData.overrides[key];
              return (
                <div key={key} className="px-6 py-3 flex flex-wrap items-center gap-3">
                  <div className="min-w-[220px] flex-1">
                    <p className="text-sm text-text-primary">{FEATURE_LABELS[key] ?? key}</p>
                    <p className="text-xs text-text-muted">
                      Tier default ({overridesData.tier}): {tierDefault ? 'on' : 'off'}
                      {existing && draft.state !== 'default' && (
                        <> · overridden by {existing.setBy} on {existing.setAt.slice(0, 10)}</>
                      )}
                    </p>
                  </div>
                  <Select
                    value={draft.state}
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
                  {draft.state !== 'default' && (
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
